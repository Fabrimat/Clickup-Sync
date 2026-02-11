# Use Node.js LTS version
FROM node:20-alpine

# Install build tools for better-sqlite3 native addon
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci && npm install -g typescript ts-node

# Copy source code and configuration
COPY tsconfig.json ./
COPY src/ ./src/

# Create data directory for SQLite
RUN mkdir -p /app/data

# Run the TypeScript application
CMD ["ts-node", "src/index.ts"]
