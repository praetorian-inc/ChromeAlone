#!/bin/bash
set -e  # Exit on any error

# Log setup progress
exec 1> >(logger -s -t $(basename $0)) 2>&1

echo "Starting relay server setup on GCP..."

# Check if we're running as root
if [ "$EUID" -ne 0 ]; then
    echo "Error: Must run as root"
    exit 1
fi

# Update system packages
apt-get update -y
echo "System packages updated"

# Install Node.js and dependencies
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs libcap2-bin
echo "Node.js and dependencies installed"

# Create app directory
echo "Creating application directory..."
mkdir -p /opt/relay-server
if [ ! -d "/opt/relay-server" ]; then
    echo "Error: Failed to create /opt/relay-server"
    exit 1
fi

cd /opt/relay-server
echo "Current directory: $(pwd)"

# Create environment file
echo "Creating environment file..."
cat << EOF > .env
RELAY_TOKEN=${relay_token}
PROXY_USER=${proxy_user}
PROXY_PASS=${proxy_pass}
PORT=443
NODE_ENV=production
EOF

if [ ! -f ".env" ]; then
    echo "Error: Failed to create .env file"
    exit 1
fi

# Create server.js
echo "Creating server.js..."
cat << 'EOFJS' > server.js
${server_js}
EOFJS

if [ ! -f "server.js" ]; then
    echo "Error: Failed to create server.js"
    exit 1
fi

# Create package.json
echo "Creating package.json..."
cat << 'EOF' > package.json
{
  "name": "relay-server",
  "version": "1.0.0",
  "description": "Secure SOCKS5 relay server",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "echo \"Error: no test specified\" && exit 1"
  }
}
EOF

# Install dependencies
echo "Installing npm dependencies..."
npm install dotenv
npm install express
npm install socksv5
npm install winston
npm install ws
npm install selfsigned

# Create a non-root user for running the service
useradd -r -s /bin/bash relay-user || true

# Allow Node.js to bind to privileged ports
echo "Setting capabilities for Node.js..."
NODEJS_BINARY=$(which node)
echo "Node.js binary location: $NODEJS_BINARY"
setcap 'cap_net_bind_service=+ep' "$NODEJS_BINARY"

# Verify the capability was set
getcap "$NODEJS_BINARY"

# Set permissions
echo "Setting permissions..."
chown -R relay-user:relay-user /opt/relay-server
chmod 600 /opt/relay-server/.env

# Setup log rotation
echo "Configuring log rotation..."
cat << EOF > /etc/logrotate.d/relay-server
/opt/relay-server/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 640 relay-user relay-user
    size 10M
}
EOF

# Create systemd service
echo "Creating systemd service..."
cat << EOF > /etc/systemd/system/relay-server.service
[Unit]
Description=Relay Server
After=network.target

[Service]
Type=simple
User=relay-user
WorkingDirectory=/opt/relay-server
Environment=PATH=/usr/bin:/usr/local/bin
ExecStart=/usr/bin/npm start
Restart=always
StandardOutput=append:/opt/relay-server/relay-server.log
StandardError=append:/opt/relay-server/relay-server-error.log

[Install]
WantedBy=multi-user.target
EOF

# Set permissions and enable service
chmod 644 /etc/systemd/system/relay-server.service
systemctl daemon-reload
systemctl enable relay-server
systemctl start relay-server

# Final checks
if [ ! -f "/opt/relay-server/server.js" ] || [ ! -f "/opt/relay-server/.env" ]; then
    echo "Error: Critical files missing after setup"
    ls -la /opt/relay-server/
    exit 1
fi

echo "GCP relay server setup complete"
