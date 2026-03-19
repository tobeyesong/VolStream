# VolStream

VolStream is a live implied-volatility dashboard backed by Yahoo Finance option chains and Black-Scholes IV calculations.

## Current stack

- `computation/black_scholes.py`: implied-vol solver
- `computation/surface_builder.py`: fetches option chains and builds the surface snapshot
- `server/server.py`: legacy gRPC server and CLI stream client support
- `web_api/app.py`: FastAPI bridge for the browser app
- `frontend/`: React + TypeScript + Vite dashboard with a focused React Three Fiber scene
- `config/instruments.json`: tracked tickers and default parameters

## Architecture

```text
Yahoo Finance -> surface_builder.py -> FastAPI (/api) -> React/TypeScript dashboard
                                 \
                                  -> gRPC server/client (legacy path)
```

The browser app is the preferred UI now. The gRPC client is still available while the migration finishes.

## Setup

```bash
# Python dependencies
make install

# Frontend dependencies
make frontend-install
```

## Run the web app

In one terminal:

```bash
make web-api
```

In a second terminal:

```bash
make frontend-dev
```

Then open [http://127.0.0.1:5173](http://127.0.0.1:5173).

## Optional legacy flow

```bash
make proto
make server
make search SEARCH_QUERY=apple
make client TICKER=AAPL
```

## Configuration

Edit `config/instruments.json` to change:

- tracked ticker symbols
- risk-free rate
- dividend yield
- update interval
- moneyness filter range

## Notes

- The web dashboard currently polls the API every 30 seconds and updates React state in place.
- The 3D surface is intentionally lazy-loaded so the core dashboard stays lighter.
- Yahoo Finance is free to prototype against, but it is not a production-grade market-data contract.
