terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.1"
    }
  }
  required_version = ">= 1.2.0"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Random ID for unique resource names
resource "random_id" "deployment" {
  byte_length = 4
}

# VPC Network - try to use default, create if it doesn't exist
resource "google_compute_network" "relay_network" {
  count                   = var.create_vpc ? 1 : 0
  name                    = "relay-network"
  auto_create_subnetworks = true
}

# Use existing default network or the newly created one
locals {
  network_name = var.create_vpc ? google_compute_network.relay_network[0].name : "default"
}

# Firewall rule for SSH access from office
resource "google_compute_firewall" "relay_ssh" {
  name    = "relay-ssh-${random_id.deployment.hex}"
  network = local.network_name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = [var.office_ip_range]
  target_tags   = ["relay-server"]
}

# Firewall rule for SOCKS proxy access from office
resource "google_compute_firewall" "relay_socks" {
  name    = "relay-socks-${random_id.deployment.hex}"
  network = local.network_name

  allow {
    protocol = "tcp"
    ports    = ["1080-1181"]
  }

  source_ranges = [var.office_ip_range]
  target_tags   = ["relay-server"]
}

# Firewall rule for WebSocket access (public)
resource "google_compute_firewall" "relay_websocket" {
  name    = "relay-websocket-${random_id.deployment.hex}"
  network = local.network_name

  allow {
    protocol = "tcp"
    ports    = ["443", "8080"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["relay-server"]
}

# Static IP for the relay server
resource "google_compute_address" "relay_ip" {
  name = "relay-ip-${random_id.deployment.hex}"
}

# Compute instance for relay server
resource "google_compute_instance" "relay_server" {
  name         = "relay-server"
  machine_type = var.machine_type
  zone         = var.zone

  tags = ["relay-server"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 30
      type  = "pd-standard"
    }
  }

  network_interface {
    network = local.network_name

    access_config {
      nat_ip = google_compute_address.relay_ip.address
    }
  }

  metadata = {
    enable-oslogin = "TRUE"
  }

  metadata_startup_script = templatefile("${path.module}/files/setup-gcp.sh", {
    relay_token = var.relay_token
    proxy_user  = var.proxy_user
    proxy_pass  = var.proxy_pass
    server_js   = file("${path.module}/files/server.js")
  })

  service_account {
    scopes = ["cloud-platform"]
  }
}

# Deploy the Google Cloud Run redirector using the google-redirector project
resource "null_resource" "deploy_redirector" {
  depends_on = [google_compute_instance.relay_server]

  provisioner "local-exec" {
    command = <<-EOT
      cd "${path.module}/../../google-redirector" && \
      BACKEND_URL="https://${google_compute_address.relay_ip.address}:443" \
      GOOGLE_CLOUD_REGION="${var.region}" \
      bash deploy.sh battleplan-${random_id.deployment.hex}
    EOT
  }

  triggers = {
    backend_ip    = google_compute_address.relay_ip.address
    deployment_id = random_id.deployment.hex
  }
}

# Get the Cloud Run service URL after deployment
data "google_cloud_run_service" "redirector" {
  depends_on = [null_resource.deploy_redirector]

  name     = "update-cache-${random_id.deployment.hex}"
  location = var.region
}
