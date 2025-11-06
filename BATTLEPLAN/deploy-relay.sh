#!/bin/bash
set -e

# Parse command line arguments
DOMAIN_NAME=""
AWS_REGION="us-east-2"  # Default region (matches build.sh default)
PROVIDER="aws"  # Default provider
GCP_PROJECT=""  # GCP project override
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain)
      DOMAIN_NAME="$2"
      shift 2
      ;;
    --region)
      AWS_REGION="$2"
      shift 2
      ;;
    --provider)
      PROVIDER="$2"
      shift 2
      ;;
    --project)
      GCP_PROJECT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--domain domain.example.com] [--region aws-region] [--provider aws|gcp] [--project gcp-project-id]"
      exit 1
      ;;
  esac
done

# Provider validation
if [[ "$PROVIDER" != "aws" && "$PROVIDER" != "gcp" ]]; then
    echo "Invalid provider: $PROVIDER. Must be 'aws' or 'gcp'"
    exit 1
fi

# Check for Terraform
if ! command -v terraform &> /dev/null; then
    echo "Terraform not found. Please install it first."
    exit 1
fi

# Provider-specific checks
if [[ "$PROVIDER" == "aws" ]]; then
    # Check for AWS CLI
    if ! command -v aws &> /dev/null; then
        echo "AWS CLI not found. Please install it first."
        exit 1
    fi

    # Configure AWS credentials if not already set
    if ! aws sts get-caller-identity &> /dev/null; then
        echo "AWS credentials not found. Run aws configure first."
        exit 1
    fi
elif [[ "$PROVIDER" == "gcp" ]]; then
    # Check for gcloud CLI
    if ! command -v gcloud &> /dev/null; then
        echo "gcloud CLI not found. Please install it first."
        exit 1
    fi

    # Check for GCP authentication and refresh token
    echo "Checking GCP authentication..."
    ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null)
    if [[ -z "$ACTIVE_ACCOUNT" ]]; then
        echo "GCP credentials not found. Run 'gcloud auth login' first."
        exit 1
    fi
    echo "Authenticated as: $ACTIVE_ACCOUNT"

    # Refresh application-default credentials for Terraform
    echo "Refreshing application-default credentials..."
    gcloud auth application-default login --quiet 2>/dev/null || {
        echo "Run 'gcloud auth application-default login' and try again."
        exit 1
    }

    # Get GCP project ID (use --project flag if provided, otherwise use gcloud default)
    if [[ -z "$GCP_PROJECT" ]]; then
        GCP_PROJECT=$(gcloud config get-value project 2>/dev/null)
        if [[ -z "$GCP_PROJECT" ]]; then
            echo "No GCP project configured. Either:"
            echo "  1. Use --project flag: ./deploy-relay.sh --provider gcp --project YOUR-PROJECT-ID"
            echo "  2. Run 'gcloud config set project YOUR-PROJECT-ID'"
            exit 1
        fi
    fi

    # Verify the project exists and we have access
    if ! gcloud projects describe "$GCP_PROJECT" &>/dev/null; then
        echo "Error: Cannot access GCP project '$GCP_PROJECT'"
        echo "Please verify the project ID and your permissions."
        exit 1
    fi

    # Enable required GCP APIs
    echo "Enabling required GCP APIs..."
    REQUIRED_APIS=(
        "compute.googleapis.com"
        "artifactregistry.googleapis.com"
        "run.googleapis.com"
    )

    for api in "${REQUIRED_APIS[@]}"; do
        echo "  - Checking $api..."
        if ! gcloud services list --enabled --project="$GCP_PROJECT" --filter="name:$api" --format="value(name)" | grep -q "$api"; then
            echo "    Enabling $api..."
            gcloud services enable "$api" --project="$GCP_PROJECT"
        else
            echo "    Already enabled"
        fi
    done

    GCP_REGION="${AWS_REGION:-us-central1}"  # Reuse AWS_REGION variable for GCP region
    echo "Using GCP project: $GCP_PROJECT"
    echo "Using GCP region: $GCP_REGION"
fi

# Create deployment directory with provider-specific subdirectory
DEPLOY_DIR="../output/relay-deployment-${PROVIDER}"
mkdir -p "$DEPLOY_DIR/files"

# Clean any existing Terraform state to avoid conflicts
rm -rf "$DEPLOY_DIR/.terraform"
rm -f "$DEPLOY_DIR/.terraform.lock.hcl"
rm -f "$DEPLOY_DIR/terraform.tfstate"
rm -f "$DEPLOY_DIR/terraform.tfstate.backup"

# Copy provider-specific Terraform configuration files
if [[ "$PROVIDER" == "aws" ]]; then
    cp main.tf variables.tf outputs.tf "$DEPLOY_DIR/"
elif [[ "$PROVIDER" == "gcp" ]]; then
    cp main-gcp.tf variables-gcp.tf outputs-gcp.tf "$DEPLOY_DIR/"
    # Rename to standard names
    mv "$DEPLOY_DIR/main-gcp.tf" "$DEPLOY_DIR/main.tf"
    mv "$DEPLOY_DIR/variables-gcp.tf" "$DEPLOY_DIR/variables.tf"
    mv "$DEPLOY_DIR/outputs-gcp.tf" "$DEPLOY_DIR/outputs.tf"
fi

cp -r files/* "$DEPLOY_DIR/files/"

cd "$DEPLOY_DIR"

# Generate secure random tokens
RELAY_TOKEN=$(openssl rand -hex 32)
PROXY_USER="admin"
PROXY_PASS=$(openssl rand -base64 32)

if [[ "$PROVIDER" == "aws" ]]; then
    # Create SSH key pair if it doesn't exist
    KEY_NAME="relay-proxy-key"
    if ! aws ec2 describe-key-pairs --region "$AWS_REGION" --key-names "$KEY_NAME" &> /dev/null; then
        echo "Creating new SSH key pair in region $AWS_REGION..."
        aws ec2 create-key-pair \
            --region "$AWS_REGION" \
            --key-name "$KEY_NAME" \
            --query 'KeyMaterial' \
            --output text > "${KEY_NAME}.pem"
        chmod 400 "${KEY_NAME}.pem"
    fi

    # Get current IP for "office_ip_range"
    CURRENT_IP=$(curl -s https://checkip.amazonaws.com)
    OFFICE_IP_RANGE="${CURRENT_IP}/32"
    echo "Detected IP address: $OFFICE_IP_RANGE"
    echo "Using AWS region: $AWS_REGION"

    # Create terraform.tfvars
    cat > terraform.tfvars << EOF
aws_region = "${AWS_REGION}"
office_ip_range = "${OFFICE_IP_RANGE}"
key_name = "${KEY_NAME}"
relay_token = "${RELAY_TOKEN}"
proxy_user = "${PROXY_USER}"
proxy_pass = "${PROXY_PASS}"
instance_type = "t3.micro"
domain_name = "${DOMAIN_NAME}"
EOF
elif [[ "$PROVIDER" == "gcp" ]]; then
    # Get current IP for firewall rule
    CURRENT_IP=$(curl -s https://checkip.amazonaws.com)
    OFFICE_IP_RANGE="${CURRENT_IP}/32"
    echo "Detected IP address: $OFFICE_IP_RANGE"
    echo "Using GCP region: $GCP_REGION"

    # Check if default network exists
    CREATE_VPC="false"
    if ! gcloud compute networks describe default --project="${GCP_PROJECT}" &>/dev/null; then
        echo "Default VPC network not found. Will create a new network."
        CREATE_VPC="true"
    fi

    # Create terraform.tfvars for GCP
    cat > terraform.tfvars << EOF
project_id = "${GCP_PROJECT}"
region = "${GCP_REGION}"
zone = "${GCP_REGION}-a"
office_ip_range = "${OFFICE_IP_RANGE}"
relay_token = "${RELAY_TOKEN}"
proxy_user = "${PROXY_USER}"
proxy_pass = "${PROXY_PASS}"
machine_type = "e2-micro"
create_vpc = ${CREATE_VPC}
EOF
fi

# Initialize and apply Terraform
echo "Initializing Terraform..."
terraform init

echo "Validating Terraform configuration..."
terraform validate

echo "Applying Terraform configuration..."
terraform apply -auto-approve

# Save connection details
echo "Saving connection details..."

if [[ "$PROVIDER" == "aws" ]]; then
    RELAY_IP=$(terraform output -raw relay_public_ip)

    cat > relay-config.txt << EOF
Relay Server Details (AWS):
====================
SOCKS5 Proxy: ${RELAY_IP}:1080
Username: ${PROXY_USER}
Password: ${PROXY_PASS}
WebSocket URL: wss://${RELAY_IP}:443
Relay Token: ${RELAY_TOKEN}
SSH Key: ${PWD}/${KEY_NAME}.pem
SSH Command: ssh -i ${KEY_NAME}.pem ec2-user@${RELAY_IP}

Example SOCKS5 Configuration:
============================
Host: ${RELAY_IP}
Info Port: 1080
Port Range: 1081-1181
Username: ${PROXY_USER}
Password: ${PROXY_PASS}

For Datacenter Agent Configuration:
=================================
RELAY_SERVER=wss://${RELAY_IP}:443
RELAY_TOKEN=${RELAY_TOKEN}
EOF

    chmod 600 relay-config.txt

    echo "Deployment complete! Configuration saved to relay-config.txt"
    echo "Allow a few minutes for the server to finish initialization."
    echo "To test the connection: ssh -i ${KEY_NAME}.pem ec2-user@${RELAY_IP}"

    # Add setup log viewing option
    echo -e "\n\nTo view setup logs:"
    echo "aws ec2 get-console-output --instance-id $(terraform output -raw relay_instance_id)"
    echo "or"
    echo "ssh -i ${KEY_NAME}.pem ec2-user@${RELAY_IP} 'sudo cat /var/log/cloud-init-output.log'"

elif [[ "$PROVIDER" == "gcp" ]]; then
    RELAY_IP=$(terraform output -raw relay_public_ip)
    REDIRECTOR_URL=$(terraform output -raw redirector_url)

    cat > relay-config.txt << EOF
Relay Server Details (GCP):
====================
Direct IP: ${RELAY_IP}
Redirector URL: ${REDIRECTOR_URL}
SOCKS5 Proxy: ${RELAY_IP}:1080
Username: ${PROXY_USER}
Password: ${PROXY_PASS}
Relay Token: ${RELAY_TOKEN}
SSH Command: gcloud compute ssh relay-server --zone=${GCP_REGION}-a

Example SOCKS5 Configuration:
============================
Host: ${RELAY_IP}
Info Port: 1080
Port Range: 1081-1181
Username: ${PROXY_USER}
Password: ${PROXY_PASS}

For Datacenter Agent Configuration (Domain Fronting):
=================================================
RELAY_SERVER=${REDIRECTOR_URL}
RELAY_TOKEN=${RELAY_TOKEN}

Note: Domain fronting via Google Cloud Run redirector eliminates need for TLS certificates.
The agent should connect to the redirector URL, which forwards to the backend relay server.
EOF

    chmod 600 relay-config.txt

    echo "Deployment complete! Configuration saved to relay-config.txt"
    echo "Allow a few minutes for the server to finish initialization."
    echo ""
    echo "GCP Deployment Details:"
    echo "  Instance: relay-server"
    echo "  Redirector: ${REDIRECTOR_URL}"
    echo "  Direct IP: ${RELAY_IP}"
    echo ""
    echo "To view setup logs:"
    echo "gcloud compute instances get-serial-port-output relay-server --zone=${GCP_REGION}-a"
fi