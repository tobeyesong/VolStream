"""
gRPC client for the implied volatility surface pipeline.

Connects to the server, subscribes to one or more tickers, and renders
a browser dashboard with clearer surface views, summary cards, and live updates.

Usage:
    python -m client.client --ticker AAPL
    python -m client.client --ticker AAPL --ticker SPY
"""

import sys
import time
import argparse
import logging
import threading
import webbrowser

import grpc

from client.dashboard import DASHBOARD_PATH, write_dashboard
from proto import vol_surface_pb2 as pb2
from proto import vol_surface_pb2_grpc as pb2_grpc

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


class SurfaceState:
    """Maintains the client-side state of a vol surface for one ticker."""

    def __init__(self, ticker: str):
        self.ticker = ticker
        self.spot_price: float = 0.0
        self.timestamp_ms: int = 0
        self.expirations: list[str] = []
        # Keyed by (strike, expiration_date) -> SurfacePoint fields
        self._points: dict[tuple[float, str], dict] = {}

    def apply_snapshot(self, update: pb2.SurfaceUpdate):
        """Replace entire state with the snapshot."""
        self._points.clear()
        self.spot_price = update.spot_price
        self.timestamp_ms = update.timestamp_ms
        self.expirations = list(update.expirations)
        for p in update.points:
            key = (p.strike, p.expiration_date)
            self._points[key] = {
                "strike": p.strike,
                "moneyness": p.moneyness,
                "time_to_expiry": p.time_to_expiry,
                "implied_vol": p.implied_vol,
                "option_price": p.option_price,
                "expiration_date": p.expiration_date,
            }
        logger.info(
            f"[{self.ticker}] SNAPSHOT applied: {len(self._points)} points, "
            f"spot={self.spot_price:.2f}"
        )

    def apply_incremental(self, update: pb2.SurfaceUpdate):
        """Merge incremental changes into existing state."""
        self.spot_price = update.spot_price
        self.timestamp_ms = update.timestamp_ms
        count = 0
        for p in update.points:
            key = (p.strike, p.expiration_date)
            self._points[key] = {
                "strike": p.strike,
                "moneyness": p.moneyness,
                "time_to_expiry": p.time_to_expiry,
                "implied_vol": p.implied_vol,
                "option_price": p.option_price,
                "expiration_date": p.expiration_date,
            }
            count += 1
        logger.info(f"[{self.ticker}] INCREMENTAL applied: {count} points updated")

    def clear(self):
        """Clear all cached state (on unsubscribe CLEAR message)."""
        self._points.clear()
        self.spot_price = 0.0
        self.timestamp_ms = 0
        self.expirations = []
        logger.info(f"[{self.ticker}] State CLEARED")


def print_search_results(query: str, instruments: list[pb2.Instrument]):
    if not instruments:
        print(f"No ticker matches found for '{query}'.")
        return

    print(f"Ticker matches for '{query}':")
    for instrument in instruments:
        suffix_parts = [part for part in (instrument.exchange, instrument.instrument_type) if part]
        suffix = f" [{' | '.join(suffix_parts)}]" if suffix_parts else ""
        print(f"{instrument.ticker:<8} {instrument.name}{suffix}")


def run_search(query: str, host: str = "localhost", port: int = 50051, limit: int = 8):
    channel = grpc.insecure_channel(f"{host}:{port}")
    stub = pb2_grpc.VolSurfaceServiceStub(channel)

    try:
        response = stub.SearchInstruments(
            pb2.InstrumentSearchRequest(query=query, limit=limit)
        )
    except grpc.RpcError as e:
        logger.error(f"Search failed: {e}")
        sys.exit(1)
    finally:
        channel.close()

    print_search_results(query, list(response.instruments))


def run_client(tickers: list[str], host: str = "localhost", port: int = 50051):
    """
    Connect to the gRPC server, subscribe to the given tickers, receive
    the initial snapshots, render the surface, and keep listening for updates.
    """
    channel = grpc.insecure_channel(f"{host}:{port}")
    stub = pb2_grpc.VolSurfaceServiceStub(channel)

    # First, list available instruments
    try:
        instruments = stub.GetInstruments(pb2.Empty())
        available = {i.ticker for i in instruments.instruments}
        logger.info(f"Configured instruments: {[i.ticker for i in instruments.instruments]}")
    except grpc.RpcError as e:
        logger.error(f"Failed to connect to server: {e}")
        sys.exit(1)

    # Validate requested tickers
    for t in tickers:
        if t not in available:
            logger.info(f"{t} not in configured defaults — attempting direct subscription anyway")

    # State management
    states: dict[str, SurfaceState] = {t: SurfaceState(t) for t in tickers}
    initial_snapshots_received = {t: threading.Event() for t in tickers}
    dashboard_dirty = threading.Event()

    def request_generator():
        """Generate subscription requests for each ticker."""
        for ticker in tickers:
            yield pb2.SubscriptionRequest(
                action=pb2.SubscriptionRequest.SUBSCRIBE,
                ticker=ticker,
            )
        # Keep the generator alive — in a real app you might send
        # unsubscribe requests based on user input.
        while True:
            time.sleep(60)

    def process_updates(response_stream):
        """Process incoming updates from the server."""
        try:
            for update in response_stream:
                ticker = update.ticker
                if ticker not in states:
                    states[ticker] = SurfaceState(ticker)

                state = states[ticker]

                if update.update_type == pb2.SurfaceUpdate.SNAPSHOT:
                    state.apply_snapshot(update)
                    if ticker in initial_snapshots_received:
                        initial_snapshots_received[ticker].set()
                    dashboard_dirty.set()

                elif update.update_type == pb2.SurfaceUpdate.INCREMENTAL:
                    state.apply_incremental(update)
                    dashboard_dirty.set()

                elif update.update_type == pb2.SurfaceUpdate.CLEAR:
                    state.clear()
                    dashboard_dirty.set()

        except grpc.RpcError as e:
            logger.error(f"Stream error: {e}")

    # Start bidirectional stream
    response_stream = stub.SubscribeSurface(request_generator())

    update_thread = threading.Thread(target=process_updates, args=(response_stream,), daemon=True)
    update_thread.start()

    should_open_browser = not DASHBOARD_PATH.exists()
    write_dashboard(states, tickers)
    if should_open_browser:
        webbrowser.open(DASHBOARD_PATH.as_uri())
        logger.info(f"Dashboard opened in browser: {DASHBOARD_PATH}")
    else:
        logger.info(f"Dashboard updated in place: {DASHBOARD_PATH}")
    logger.info("Waiting for initial snapshots...")

    try:
        while True:
            for ticker in tickers:
                if not initial_snapshots_received[ticker].is_set():
                    received = initial_snapshots_received[ticker].wait(timeout=1)
                    if received:
                        logger.info(f"Initial snapshot received for {ticker}")

            dirty = dashboard_dirty.wait(timeout=5)
            if dirty:
                dashboard_dirty.clear()
            write_dashboard(states, tickers)
    except KeyboardInterrupt:
        logger.info("Client shutting down.")
        channel.close()


def main():
    parser = argparse.ArgumentParser(description="VolStream gRPC Client")
    mode_group = parser.add_mutually_exclusive_group(required=True)
    mode_group.add_argument(
        "--ticker", "-t",
        action="append",
        help="Ticker symbol to subscribe to (can specify multiple times)",
    )
    mode_group.add_argument(
        "--search",
        help="Search Yahoo Finance-backed instruments by ticker or company name",
    )
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=50051)
    parser.add_argument("--limit", type=int, default=8, help="Maximum number of search results")
    args = parser.parse_args()

    if args.search:
        run_search(args.search, args.host, args.port, args.limit)
        return

    tickers = [t.upper() for t in args.ticker]
    run_client(tickers, args.host, args.port)


if __name__ == "__main__":
    main()
