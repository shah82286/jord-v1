#!/bin/bash
# JORD Golf Tournament System — Local Startup
# Double-click this file or run: bash start.sh

echo ""
echo "⛳ JORD Golf Tournament System"
echo "================================"

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Download from https://nodejs.org (install the LTS version)"
  exit 1
fi

NODE_VER=$(node -v | cut -c 2- | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "❌ Node.js 18+ required. You have $(node -v). Download from https://nodejs.org"
  exit 1
fi

echo "✅ Node.js $(node -v)"

# Install dependencies
if [ ! -d "node_modules" ]; then
  echo ""
  echo "📦 Installing dependencies (first time only)..."
  npm install --silent
fi

# Create .env if missing
if [ ! -f ".env" ]; then
  echo ""
  echo "⚙️  Creating config file..."
  cp .env.example .env
  echo ""
  echo "📝 IMPORTANT: Open .env in a text editor and add your Mapbox token."
  echo "   Get a free token at: https://mapbox.com (takes 2 minutes)"
  echo ""
  read -p "Press Enter to continue with defaults, or Ctrl+C to set up .env first..."
fi

# Run tests
echo ""
echo "🧪 Running tests..."
node tests/run-tests.js
if [ $? -ne 0 ]; then
  echo "⚠️  Tests failed — check output above"
  read -p "Press Enter to start anyway, or Ctrl+C to exit..."
fi

echo ""
echo "🚀 Starting server..."
echo ""
echo "   Admin Panel:    http://localhost:3000/admin"
echo "   Default password: jord2026"
echo "   (Change in .env → ADMIN_PASSWORD)"
echo ""
echo "   Press Ctrl+C to stop the server"
echo ""

node server.js
