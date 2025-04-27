#!/bin/bash

# ANSI color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

echo "TunTap Bridge Linux Prerequisites Check"
echo "======================================"
echo

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${YELLOW}Warning: Not running as root. Some checks may fail.${NC}"
  echo "For a complete check, run this script with sudo."
  echo
fi

# Check if TUN/TAP module is loaded
echo -n "Checking TUN/TAP kernel module... "
if lsmod | grep -q "^tun"; then
  echo -e "${GREEN}LOADED${NC}"
else
  echo -e "${RED}NOT LOADED${NC}"
  echo "  To load the TUN/TAP module, run: sudo modprobe tun"
  echo "  To load it automatically at boot, run: echo \"tun\" | sudo tee -a /etc/modules"
fi

# Check if /dev/net/tun exists
echo -n "Checking /dev/net/tun device... "
if [ -e /dev/net/tun ]; then
  echo -e "${GREEN}EXISTS${NC}"
  
  # Check permissions on /dev/net/tun
  echo -n "Checking /dev/net/tun permissions... "
  TUN_PERMS=$(ls -la /dev/net/tun | awk '{print $1}')
  TUN_GROUP=$(ls -la /dev/net/tun | awk '{print $4}')
  echo "$TUN_PERMS ($TUN_GROUP)"
  
  # Check if current user can access /dev/net/tun
  echo -n "Can current user access /dev/net/tun? "
  if [ -r /dev/net/tun ] && [ -w /dev/net/tun ]; then
    echo -e "${GREEN}YES${NC}"
  else
    echo -e "${RED}NO${NC}"
    echo "  To fix permissions, you can:"
    echo "  1. Run your application with sudo"
    echo "  2. Add your user to the '$TUN_GROUP' group: sudo usermod -a -G $TUN_GROUP $USER"
    echo "  3. Create a udev rule: echo 'KERNEL==\"tun\", GROUP=\"$USER\", MODE=\"0660\"' | sudo tee /etc/udev/rules.d/99-tuntap.rules"
  fi
else
  echo -e "${RED}MISSING${NC}"
  echo "  The TUN/TAP device file is missing. This usually means the kernel module is not loaded."
  echo "  Try running: sudo modprobe tun"
fi

# Check for iproute2 package
echo -n "Checking for 'ip' command (iproute2)... "
if command -v ip &> /dev/null; then
  echo -e "${GREEN}INSTALLED${NC} ($(which ip))"
else
  echo -e "${RED}MISSING${NC}"
  echo "  The 'ip' command is required for configuring network interfaces."
  echo "  Install it with: sudo apt install iproute2 (Debian/Ubuntu)"
  echo "                   sudo yum install iproute (CentOS/RHEL)"
  echo "                   sudo pacman -S iproute2 (Arch Linux)"
fi

# Check for kernel headers
echo -n "Checking for kernel headers... "
KERNEL_VERSION=$(uname -r)
if [ -d "/lib/modules/$KERNEL_VERSION/build" ]; then
  echo -e "${GREEN}INSTALLED${NC}"
else
  echo -e "${YELLOW}POSSIBLY MISSING${NC}"
  echo "  Kernel headers are required for building the native module."
  echo "  Install them with: sudo apt install linux-headers-$(uname -r) (Debian/Ubuntu)"
  echo "                     sudo yum install kernel-devel (CentOS/RHEL)"
  echo "                     sudo pacman -S linux-headers (Arch Linux)"
fi

# Check for sudo privileges
echo -n "Checking sudo privileges... "
if sudo -n true 2>/dev/null; then
  echo -e "${GREEN}AVAILABLE${NC}"
else
  echo -e "${YELLOW}REQUIRES PASSWORD${NC}"
  echo "  The module uses sudo to configure network interfaces."
  echo "  You'll be prompted for your password when running applications that use this module."
  echo "  To avoid password prompts, you can configure sudo to allow specific commands without a password."
fi

echo
echo "Prerequisites check completed."
echo "For more information, see the README.md file."
