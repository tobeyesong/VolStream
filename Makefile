VENV ?= .venv
PYTHON ?= python3
VENV_PYTHON := $(VENV)/bin/python
VENV_PIP := $(VENV)/bin/pip
TICKER ?= AAPL
SEARCH_QUERY ?= apple
DEPS_STAMP := $(VENV)/.deps-installed
PROTO_GENERATED := proto/vol_surface_pb2.py proto/vol_surface_pb2_grpc.py

.PHONY: venv install proto server client search web-api frontend-install frontend-dev frontend-build clean

venv:
	@test -x $(VENV_PYTHON) || $(PYTHON) -m venv $(VENV)

$(DEPS_STAMP): requirements.txt | venv
	$(VENV_PIP) install --upgrade pip
	$(VENV_PIP) install -r requirements.txt
	touch $(DEPS_STAMP)

install: $(DEPS_STAMP)

$(PROTO_GENERATED): proto/vol_surface.proto $(DEPS_STAMP)
	$(VENV_PYTHON) -m grpc_tools.protoc \
		-I . \
		--python_out=. \
		--grpc_python_out=. \
		proto/vol_surface.proto

proto: $(PROTO_GENERATED)

server: $(PROTO_GENERATED)
	$(VENV_PYTHON) -m server.server

client: $(PROTO_GENERATED)
	$(VENV_PYTHON) -m client.client --ticker $(TICKER)

search: $(PROTO_GENERATED)
	$(VENV_PYTHON) -m client.client --search "$(SEARCH_QUERY)"

web-api: $(PROTO_GENERATED)
	$(VENV_PYTHON) -m uvicorn web_api.app:app --reload

frontend-install:
	cd frontend && npm install

frontend-dev:
	cd frontend && npm run dev -- --host

frontend-build:
	cd frontend && npm run build

clean:
	rm -f proto/*_pb2.py proto/*_pb2_grpc.py
	find . -name '*.pyc' -delete
	find . -type d -name __pycache__ -empty -delete
	rm -rf frontend/dist
