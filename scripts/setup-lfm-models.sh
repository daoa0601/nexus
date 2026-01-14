#!/bin/bash
# Download and setup LFM GGUF models in Ollama
#
# This script pulls Liquid AI's LFM (Lightweight Foundational Model) GGUF models
# from HuggingFace and makes them available in Ollama.
#
# Usage:
#   ./scripts/setup-lfm-models.sh
#
# Requirements:
#   - Ollama installed and running
#   - ~8GB free disk space
#   - Internet connection

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# LFM models to pull from HuggingFace
MODELS=(
    "hf.co/LiquidAI/LFM2-350M-Q4_K_M-GGUF"
    "hf.co/LiquidAI/LFM2-1.2B-GGUF"
    "hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF"
)

echo "=================================="
echo "LFM Models Setup for Ollama"
echo "=================================="
echo ""
echo "This will download the following LFM models:"
for model in "${MODELS[@]}"; do
    echo "  • $model"
done
echo ""

# Check if ollama is installed
if ! command -v ollama &> /dev/null; then
    echo -e "${RED}Error: Ollama is not installed${NC}"
    echo "Visit https://ollama.ai to install Ollama"
    exit 1
fi

# Check if ollama is running
if ! ollama list &> /dev/null; then
    echo -e "${YELLOW}Warning: Ollama may not be running${NC}"
    echo "Start Ollama with: ollama serve"
    echo ""
fi

# Pull each model
SUCCESS_COUNT=0
FAIL_COUNT=0

for model in "${MODELS[@]}"; do
    echo ""
    echo "Pulling $model..."

    if ollama pull "$model"; then
        echo -e "${GREEN}✓ Successfully pulled $model${NC}"
        ((SUCCESS_COUNT++))
    else
        echo -e "${RED}✗ Failed to pull $model${NC}"
        ((FAIL_COUNT++))
    fi
done

echo ""
echo "=================================="
echo "Summary"
echo "=================================="
echo "Successfully pulled: $SUCCESS_COUNT/${#MODELS[@]}"
echo "Failed: $FAIL_COUNT/${#MODELS[@]}"

# List installed models
echo ""
echo "Verifying LFM models in Ollama..."
echo ""

if ollama list | grep -i lfm; then
    echo ""
    echo -e "${GREEN}LFM models are ready!${NC}"
    echo ""
    echo "Test a model:"
    echo "  ollama run hf.co/LiquidAI/LFM2-350M-Q4_K_M-GGUF 'Hello, how are you?'"
else
    echo ""
    echo -e "${YELLOW}No LFM models found in Ollama${NC}"
    echo "Check the errors above and try again"
fi

echo ""
echo "Done!"
