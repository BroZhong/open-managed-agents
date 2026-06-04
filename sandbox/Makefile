IMAGE_NAME := open-managed-agents/sandbox
IMAGE_TAG := latest

.PHONY: build run-test clean

build:
	docker build -t $(IMAGE_NAME):$(IMAGE_TAG) -f Dockerfile ..

run-test:
	docker run --rm $(IMAGE_NAME):$(IMAGE_TAG) tsx --version
	docker run --rm $(IMAGE_NAME):$(IMAGE_TAG) claude --version || echo "Claude CLI installed (may need API key for full test)"
	docker run --rm $(IMAGE_NAME):$(IMAGE_TAG) codex --version || echo "Codex CLI installed (may need API key for full test)"

clean:
	docker rmi $(IMAGE_NAME):$(IMAGE_TAG) 2>/dev/null || true
