# VolStream

VolStream is a browser-first implied volatility dashboard built on Yahoo Finance option chains and a Black-Scholes IV solver. It lets you search for tickers, pull a live surface snapshot, and inspect the shape through a heatmap, term structure, skew view, and a lightweight 3D scene.

The preferred path today is:

```text
Yahoo Finance -> Python surface builder -> FastAPI (/api) -> React + TypeScript dashboard
```

The older gRPC server/client flow is still in the repo, but the web app is the main interface.

## What it does

- Searches configured instruments plus live Yahoo Finance symbol results
- Builds an implied volatility surface from option chain call data
- Filters contracts by moneyness before solving for IV
- Serves the surface through a small FastAPI layer
- Renders a dashboard with:
  - ticker search
  - surface heatmap
  - front-month skew
  - ATM term structure
  - highest-IV contracts table
  - lazy-loaded React Three Fiber scene

## Stack

- Python for market-data fetch, IV calculation, API, and legacy gRPC support
- FastAPI + Uvicorn for the browser-facing API
- React 19 + TypeScript + Vite for the frontend
- Yahoo Finance via `yfinance` as the data source
- NumPy + SciPy for numerical work

## Repo layout

- `computation/black_scholes.py`: implied volatility solver
- `computation/surface_builder.py`: option-chain fetch and surface snapshot builder
- `web_api/app.py`: FastAPI endpoints consumed by the frontend
- `frontend/`: React dashboard
- `config/instruments.json`: tracked instruments and surface defaults
- `server/server.py`: legacy gRPC server
- `client/client.py`: legacy CLI client and instrument search

## Quick start

Prerequisites:

- Python 3.10+
- A recent Node.js + npm install

Install dependencies:

```bash
make install
make frontend-install
```

Run the API in one terminal:

```bash
make web-api
```

Run the frontend in a second terminal:

```bash
make frontend-dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173).

## Make targets

```bash
make install            # create .venv and install Python deps
make proto              # regenerate gRPC stubs
make web-api            # run FastAPI with reload
make frontend-install   # install frontend packages
make frontend-dev       # run Vite dev server
make frontend-build     # production frontend build
make server             # legacy gRPC server
make search SEARCH_QUERY=apple
make client TICKER=AAPL
```

## API surface

The FastAPI app lives in `web_api/app.py` and exposes:

- `GET /api/health`: health check
- `GET /api/instruments`: instruments from `config/instruments.json`
- `GET /api/instruments/search?q=AAPL&limit=8`: symbol/company lookup
- `GET /api/surface/{ticker}`: current surface snapshot for a ticker

Example:

```bash
curl http://127.0.0.1:8000/api/surface/AAPL
```

## Configuration

Edit `config/instruments.json` to control:

- tracked instruments shown by default
- `risk_free_rate`
- `dividend_yield`
- `moneyness_min`
- `moneyness_max`
- `update_interval_seconds`
- legacy gRPC host/port settings

Current defaults include `AAPL`, `SPY`, `TSLA`, and `QQQ`.

## Legacy gRPC workflow

The browser app is the main product, but the original gRPC path still works:

```bash
make proto
make server
make search SEARCH_QUERY=tesla
make client TICKER=TSLA
```

## Implementation notes

- Surface snapshots are built from call options across all available expirations.
- Contracts outside the configured moneyness band are ignored.
- IV points with invalid or obviously nonsensical outputs are dropped.
- The frontend polls for fresh surface data every 30 seconds.
- The 3D scene is lazy-loaded so the first dashboard render stays lighter.

## Limitations

- Yahoo Finance is useful for prototyping, but it is not a production-grade market data feed.
- Availability and latency depend on the upstream Yahoo endpoints.
- There is no automated test suite in the repo yet.
