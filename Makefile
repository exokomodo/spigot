SHELL := /usr/bin/env
.SHELLFLAGS = bash -e -o pipefail -c
.DEFAULT_GOAL := help
.NOTPARALLEL:
.SILENT:
.ONESHELL:

ifndef VERBOSE
MAKEFLAGS += --no-print-directory
endif

ifneq (,$(wildcard ./.env))
	include .env
	export
endif

JS_EXEC ?= npm
JS_INSTALL ?= install

MAIN ?= ./src/main.ts
EXE ?= ./build/index.js

##@ Development Environment

.PHONY: setup
setup: setup/js ## Set up development environment

.PHONY: setup/js
setup/js: ## Install Node.js via nvm and project dependencies
	if ! [ -s "$$HOME/.nvm/nvm.sh" ]; then \
		curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash; \
	fi
	. $$HOME/.nvm/nvm.sh
	nvm install
	$(JS_EXEC) $(JS_INSTALL)

##@ Build

.PHONY: build
build: build/ts ## Build codebase

.PHONY: build/ts
build/ts: ## Compile TypeScript
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run build

.PHONY: clean
clean: ## Clean build artifacts
	rm -rf \
		./build \
		./tmp

##@ Run

.PHONY: run
run: ## Run the application (dev mode)
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run dev

.PHONY: watch
watch: ## Watch for changes and recompile
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run watch

##@ Testing

.PHONY: test
test: ## Run tests
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run test

##@ Dependencies

.PHONY: deps
deps: ## Install dependencies
	$(JS_EXEC) $(JS_INSTALL)

.PHONY: upgrade
upgrade: upgrade/ts ## Upgrade all dependencies

.PHONY: upgrade/ts
upgrade/ts: ## Upgrade TypeScript dependencies
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run check-updates
	$(JS_EXEC) $(JS_INSTALL)

##@ Code Quality

.PHONY: check
check: check/ts ## Check code quality

.PHONY: check/ts
check/ts: ## Check TypeScript code quality (lint + types)
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run lint

.PHONY: lint
lint: lint/ts ## Lint codebase

.PHONY: lint/ts
lint/ts: ## Lint TypeScript code
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run lint

.PHONY: format
format: format/ts ## Format code

.PHONY: format/ts
format/ts: ## Format TypeScript code (Prettier)
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run fix:prettier

.PHONY: fix
fix: fix/ts ## Fix lint and format errors

.PHONY: fix/ts
fix/ts: ## Fix TypeScript lint and format errors
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run fix

##@ Helpers

.PHONY: help
help: ## Display this help
	awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

env-%: ## Check if env var is defined
	if [ -z "$($*)" ]; then \
		echo "Error: Environment variable '$*' is not set."; \
		exit 1; \
	fi
