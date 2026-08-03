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
EXE ?= ./build/main.js

NODE_VERSION := $(shell cat .nvmrc 2>/dev/null)
NVM_DIR ?= $(HOME)/.nvm

# A non-interactive SSH shell never sources nvm.sh, so `node` is off PATH even
# when nvm installed it. Fall back to the nvm directory: the version in .nvmrc
# first, then the newest one present.
NODE_BIN ?= $(shell { \
	command -v node 2>/dev/null || true; \
	ls -1 $(NVM_DIR)/versions/node/v$(NODE_VERSION)*/bin/node 2>/dev/null | sort -V | tail -1 || true; \
	ls -1 $(NVM_DIR)/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -1 || true; \
	} | head -1)

ifneq (,$(NODE_BIN))
export PATH := $(patsubst %/,%,$(dir $(NODE_BIN))):$(PATH)
endif

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

##@ Deployment

# These targets run *on the server*, over SSH from the CD workflow. Override any
# of them on the command line, e.g. `make deploy SERVER_NAME=spigot.example.com`.
SERVICE_NAME ?= spigot
DEPLOY_BRANCH ?= main
DEPLOY_DIR ?= $(CURDIR)
DEPLOY_USER ?= $(shell id -un)
REPO_URL ?= $(shell git remote get-url origin 2>/dev/null || echo https://github.com/exokomodo/spigot.git)
SERVER_NAME ?= _
APP_HOST ?= 127.0.0.1
APP_PORT ?= 3000
STATE_DIR ?= /var/lib/$(SERVICE_NAME)
SUDO ?= sudo
NGINX_AVAILABLE_DIR ?= /etc/nginx/sites-available
NGINX_ENABLED_DIR ?= /etc/nginx/sites-enabled
NGINX_SNIPPETS_DIR ?= /etc/nginx/snippets
SYSTEMD_DIR ?= /etc/systemd/system

# Certbot runs in `certonly --webroot` mode, so it only ever writes to
# CERT_DIR and never edits the nginx config this repo owns.
ACME_WEBROOT ?= /var/www/certbot
CERT_DIR ?= /etc/letsencrypt/live/$(SERVER_NAME)
CERTBOT_EMAIL ?=

# Substitutes the @PLACEHOLDER@ tokens in the etc/ templates.
RENDER = sed \
	-e 's|@SERVICE_NAME@|$(SERVICE_NAME)|g' \
	-e 's|@DEPLOY_DIR@|$(DEPLOY_DIR)|g' \
	-e 's|@DEPLOY_USER@|$(DEPLOY_USER)|g' \
	-e 's|@SERVER_NAME@|$(SERVER_NAME)|g' \
	-e 's|@APP_HOST@|$(APP_HOST)|g' \
	-e 's|@APP_PORT@|$(APP_PORT)|g' \
	-e 's|@NODE_BIN@|$(NODE_BIN)|g' \
	-e 's|@STATE_DIR@|$(STATE_DIR)|g' \
	-e 's|@ACME_WEBROOT@|$(ACME_WEBROOT)|g' \
	-e 's|@CERT_DIR@|$(CERT_DIR)|g'

.PHONY: deploy
deploy: deploy/pull deploy/node ## Deploy on this host: sync, install Node, check, build, restart
	# Re-invoked in the deploy directory so the freshly pulled Makefile runs the
	# release, and so NODE_BIN is re-resolved after nvm may have installed Node.
	$(MAKE) -C $(DEPLOY_DIR) deploy/release

.PHONY: deploy/release
deploy/release: deploy/doctor deploy/build deploy/nginx deploy/systemd ## Check, build, and install configs without syncing
	echo "Deployed $(SERVICE_NAME) from $$(git -C $(DEPLOY_DIR) rev-parse --short HEAD)"

.PHONY: deploy/pull
deploy/pull: ## Clone the repo if missing, otherwise reset it to origin/$(DEPLOY_BRANCH)
	if [ -d "$(DEPLOY_DIR)/.git" ]; then
		git -C $(DEPLOY_DIR) fetch --prune origin $(DEPLOY_BRANCH)
		git -C $(DEPLOY_DIR) checkout $(DEPLOY_BRANCH)
		git -C $(DEPLOY_DIR) reset --hard origin/$(DEPLOY_BRANCH)
	else
		echo "No checkout at $(DEPLOY_DIR); cloning $(REPO_URL)"
		# Only escalate when the parent directory is not already writable.
		mkdir -p $(DEPLOY_DIR) 2>/dev/null || $(SUDO) install -d -o $(DEPLOY_USER) $(DEPLOY_DIR)
		git clone --branch $(DEPLOY_BRANCH) $(REPO_URL) $(DEPLOY_DIR)
	fi

.PHONY: deploy/node
deploy/node: ## Install the .nvmrc Node version via nvm
	if ! [ -s "$(NVM_DIR)/nvm.sh" ]; then
		echo "Error: nvm is not installed at $(NVM_DIR)."
		echo "Run 'make setup/js' to install it, or install Node $(NODE_VERSION)"
		echo "system-wide and re-run with NODE_BIN=/path/to/node."
		exit 1
	fi
	cd $(DEPLOY_DIR)
	# nvm.sh trips `set -e` while loading; it reads .nvmrc from the cwd.
	set +e
	. $(NVM_DIR)/nvm.sh
	set -e
	nvm install
	nvm use
	node --version

.PHONY: deploy/build
deploy/build: ## Install exact dependencies and compile
	$(JS_EXEC) ci
	$(JS_EXEC) run build

.PHONY: deploy/nginx
deploy/nginx: ## Install the nginx site and reload nginx
	site=$(NGINX_AVAILABLE_DIR)/$(SERVICE_NAME).conf
	snippet=$(NGINX_SNIPPETS_DIR)/$(SERVICE_NAME)-proxy.conf
	staged="$$(mktemp)"
	backup="$$(mktemp -d)"
	trap 'rm -rf "$$staged" "$$backup"' EXIT
	# A failed `nginx -t` must not leave a broken config behind, or the next
	# unrelated reload breaks the site.
	for installed in "$$site" "$$snippet"; do
		if [ -f "$$installed" ]; then cp "$$installed" "$$backup/$$(basename "$$installed")"; fi
	done
	# Serve the HTTPS config only once a certificate actually exists, otherwise
	# nginx -t fails on the missing ssl_certificate and takes the deploy with it.
	if [ -f $(CERT_DIR)/fullchain.pem ]; then
		source=./etc/nginx/$(SERVICE_NAME)-tls.conf
		echo "nginx: HTTPS ($(CERT_DIR))"
	else
		source=./etc/nginx/$(SERVICE_NAME).conf
		echo "nginx: HTTP only; run 'make deploy/tls' to issue a certificate"
	fi
	$(SUDO) install -d -m 0755 $(ACME_WEBROOT)
	$(RENDER) ./etc/nginx/snippets/$(SERVICE_NAME)-proxy.conf > "$$staged"
	$(SUDO) install -D -m 0644 "$$staged" "$$snippet"
	$(RENDER) "$$source" > "$$staged"
	$(SUDO) install -D -m 0644 "$$staged" "$$site"
	$(SUDO) ln -sfn "$$site" $(NGINX_ENABLED_DIR)/$(SERVICE_NAME).conf
	# The stock default site also listens on :80 and would shadow this one.
	$(SUDO) rm -f $(NGINX_ENABLED_DIR)/default
	if ! $(SUDO) nginx -t; then
		echo "nginx rejected the config; rolling back and leaving nginx untouched."
		for installed in "$$site" "$$snippet"; do
			previous="$$backup/$$(basename "$$installed")"
			if [ -f "$$previous" ]; then
				$(SUDO) install -m 0644 "$$previous" "$$installed"
			else
				$(SUDO) rm -f "$$installed" $(NGINX_ENABLED_DIR)/$(SERVICE_NAME).conf
			fi
		done
		exit 1
	fi
	$(SUDO) systemctl reload nginx

.PHONY: deploy/tls
deploy/tls: ## Issue a Let's Encrypt certificate for $(SERVER_NAME), then switch to HTTPS
	if [ "$(SERVER_NAME)" = "_" ]; then
		echo "Error: SERVER_NAME is '_', which is not a real hostname."
		echo "Re-run as: make deploy/tls SERVER_NAME=spigot.example.com CERTBOT_EMAIL=you@example.com"
		exit 1
	fi
	if ! command -v certbot >/dev/null 2>&1; then
		echo "Error: certbot is not installed."
		echo "Run: $(SUDO) apt-get install -y certbot"
		exit 1
	fi
	if [ -z "$(CERTBOT_EMAIL)" ]; then
		echo "Error: CERTBOT_EMAIL is not set; Let's Encrypt needs it for expiry notices."
		echo "Re-run as: make deploy/tls SERVER_NAME=$(SERVER_NAME) CERTBOT_EMAIL=you@example.com"
		exit 1
	fi
	# The HTTP site must already be serving $(ACME_WEBROOT) for the challenge.
	$(MAKE) deploy/nginx
	# certonly, so certbot issues the certificate and never edits nginx config.
	$(SUDO) certbot certonly \
		--webroot \
		--webroot-path $(ACME_WEBROOT) \
		--domain $(SERVER_NAME) \
		--email $(CERTBOT_EMAIL) \
		--agree-tos \
		--no-eff-email \
		--keep-until-expiring \
		--deploy-hook 'systemctl reload nginx'
	# Now that the certificate exists, this installs the HTTPS config.
	$(MAKE) deploy/nginx

.PHONY: deploy/systemd
deploy/systemd: ## Install the systemd unit and restart the service
	rendered="$$(mktemp)"
	trap 'rm -f "$$rendered"' EXIT
	$(RENDER) ./etc/systemd/$(SERVICE_NAME).service > "$$rendered"
	$(SUDO) install -D -m 0644 "$$rendered" $(SYSTEMD_DIR)/$(SERVICE_NAME).service
	$(SUDO) install -d -m 0755 -o $(DEPLOY_USER) $(STATE_DIR)
	if ! [ -f /etc/$(SERVICE_NAME)/$(SERVICE_NAME).env ]; then \
		$(SUDO) install -D -m 0640 -o $(DEPLOY_USER) \
			./etc/systemd/$(SERVICE_NAME).env.example \
			/etc/$(SERVICE_NAME)/$(SERVICE_NAME).env; \
	fi
	$(SUDO) systemctl daemon-reload
	$(SUDO) systemctl enable $(SERVICE_NAME).service
	$(SUDO) systemctl restart $(SERVICE_NAME).service
	sleep 2
	if ! $(SUDO) systemctl is-active --quiet $(SERVICE_NAME).service; then \
		echo "Error: $(SERVICE_NAME).service failed to start. Recent logs:"; \
		$(SUDO) journalctl -u $(SERVICE_NAME).service -n 50 --no-pager; \
		exit 1; \
	fi

.PHONY: deploy/status
deploy/status: ## Show service status and recent logs
	$(SUDO) systemctl status --no-pager --full $(SERVICE_NAME).service || true
	$(SUDO) journalctl -u $(SERVICE_NAME).service -n 50 --no-pager

.PHONY: deploy/logs
deploy/logs: ## Follow the service logs
	$(SUDO) journalctl -u $(SERVICE_NAME).service -f

.PHONY: deploy/doctor
deploy/doctor: ## Check that this host can be deployed to
	failed=0
	check() { \
		if eval "$$2" >/dev/null 2>&1; then \
			echo "  ok    $$1"; \
		else \
			echo "  FAIL  $$1 -> $$3"; \
			failed=1; \
		fi; \
	}
	echo "Deploy target: $(DEPLOY_USER)@$$(hostname) $(DEPLOY_DIR) (branch $(DEPLOY_BRANCH))"
	check "git checkout" "git -C $(DEPLOY_DIR) rev-parse --git-dir" \
		"clone the repo to $(DEPLOY_DIR) first"
	check "node found ($(NODE_BIN))" "[ -x '$(NODE_BIN)' ]" \
		"run 'make setup/js' to install Node $(NODE_VERSION) via nvm, or pass NODE_BIN=/path/to/node"
	check "npm found" "command -v $(JS_EXEC)" \
		"run 'make setup/js'; $(JS_EXEC) ships with Node"
	check "systemd available" "command -v systemctl" \
		"this deployment needs a systemd host"
	check "nginx installed" "command -v nginx" \
		"install nginx, e.g. 'sudo apt-get install -y nginx'"
	check "passwordless sudo" "$(SUDO) -n true" \
		"grant NOPASSWD sudo to $(DEPLOY_USER) so CD can run unattended"
	check "unit template" "[ -f ./etc/systemd/$(SERVICE_NAME).service ]" \
		"run make from the repo root"
	check "nginx template" "[ -f ./etc/nginx/$(SERVICE_NAME).conf ]" \
		"run make from the repo root"
	if [ -f $(CERT_DIR)/fullchain.pem ]; then \
		echo "  ok    TLS certificate for $(SERVER_NAME)"; \
	else \
		echo "  note  no certificate for $(SERVER_NAME); serving HTTP only (see 'make deploy/tls')"; \
	fi
	if [ "$$failed" -ne 0 ]; then \
		echo "Deploy prerequisites are missing; fix the FAIL lines above."; \
		exit 1; \
	fi
	echo "Ready to deploy."

##@ Helpers

.PHONY: help
help: ## Display this help
	awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

env-%: ## Check if env var is defined
	if [ -z "$($*)" ]; then \
		echo "Error: Environment variable '$*' is not set."; \
		exit 1; \
	fi
