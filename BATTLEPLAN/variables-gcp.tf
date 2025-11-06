variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "region" {
  description = "GCP region to deploy resources"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone to deploy compute instance"
  type        = string
  default     = "us-central1-a"
}

variable "office_ip_range" {
  description = "CIDR block for office IP range"
  type        = string
  validation {
    condition     = can(cidrhost(var.office_ip_range, 0))
    error_message = "The office_ip_range must be a valid CIDR block"
  }
}

variable "machine_type" {
  description = "GCP machine type"
  type        = string
  default     = "e2-micro"
}

variable "relay_token" {
  description = "Authentication token for relay server"
  type        = string
  sensitive   = true
}

variable "proxy_user" {
  description = "Username for SOCKS proxy"
  type        = string
  sensitive   = true
}

variable "proxy_pass" {
  description = "Password for SOCKS proxy"
  type        = string
  sensitive   = true
}

variable "create_vpc" {
  description = "Create a new VPC network (set to true if default network doesn't exist)"
  type        = bool
  default     = false
}
