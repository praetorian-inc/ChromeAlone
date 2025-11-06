output "relay_public_ip" {
  description = "Public IP of the relay server"
  value       = google_compute_address.relay_ip.address
}

output "relay_instance_name" {
  description = "Name of the relay server instance"
  value       = google_compute_instance.relay_server.name
}

output "relay_instance_zone" {
  description = "Zone of the relay server instance"
  value       = google_compute_instance.relay_server.zone
}

output "redirector_url" {
  description = "Google Cloud Run redirector URL for domain fronting"
  value       = data.google_cloud_run_service.redirector.status[0].url
}

output "socks_proxy_address" {
  description = "SOCKS proxy address"
  value       = "${google_compute_address.relay_ip.address}:1080"
}
