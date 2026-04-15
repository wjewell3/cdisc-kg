#!/usr/bin/env bash
# build-push.sh — Build the server Docker image and push to OCIR (OCI Registry)
# Usage:  ./build-push.sh [tag]
#
# Prerequisites:
#   docker login <region>.ocir.io -u '<tenancy-namespace>/oracleidentitycloudservice/<username>'
#
# Env vars:
#   OCIR_REGISTRY  e.g.  iad.ocir.io/mytenancy/cdisc-kg
#   IMAGE_TAG      defaults to "latest"

set -euo pipefail

REGISTRY="${OCIR_REGISTRY:-}"
TAG="${1:-${IMAGE_TAG:-latest}}"

if [[ -z "$REGISTRY" ]]; then
  echo "Error: set OCIR_REGISTRY=<region>.ocir.io/<tenancy-namespace>/cdisc-kg" >&2
  exit 1
fi

IMAGE="${REGISTRY}/cdisc-kg-server:${TAG}"

echo "Building $IMAGE for linux/arm64…"
docker buildx build \
  --platform linux/arm64 \
  --push \
  -t "$IMAGE" \
  ./server

echo ""
echo "Pushed: $IMAGE"
echo ""
echo "To deploy/update on OKE:"
echo "  sed -i 's|REGISTRY/cdisc-kg-server:latest|${IMAGE}|g' k8s/deployment.yaml k8s/cronjob.yaml"
echo "  kubectl apply -f k8s/"
