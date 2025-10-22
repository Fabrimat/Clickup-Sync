# Use Node.js LTS version
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && \
    npm install -g typescript ts-node

# Copy source code and configuration
COPY tsconfig.json ./
COPY clickup-sync.ts ./

# Copy .env file (or use environment variables at runtime)
COPY .env* ./ 2>/dev/null || true

# Run the TypeScript application
CMD ["ts-node", "clickup-sync.ts"]
