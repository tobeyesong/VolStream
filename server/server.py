"""
gRPC server for the implied volatility surface pipeline.

- Reads config/instruments.json for tracked tickers and defaults
- Periodically recomputes vol surfaces for subscribed tickers
- Streams snapshots and incremental updates to connected clients
- Handles subscribe/unsubscribe via bidirectional streaming
"""

import json
import time
import logging
import threading
from pathlib import Path
from concurrent import futures
from collections import defaultdict

import grpc
import yfinance as yf

# These imports assume you've run protoc to generate the pb2 files.
# See README for the generation command.
from proto import vol_surface_pb2 as pb2
from proto import vol_surface_pb2_grpc as pb2_grpc
from computation.surface_builder import build_surface, compute_incremental_update, VolSurfaceSnapshot

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "instruments.json"
MAX_SEARCH_RESULTS = 20
SUPPORTED_SEARCH_TYPES = {"EQUITY", "ETF", "INDEX"}


def load_config() -> dict:
    with open(CONFIG_PATH) as f:
        return json.load(f)


def snapshot_to_proto(snap: VolSurfaceSnapshot, update_type: int) -> pb2.SurfaceUpdate:
    """Convert internal snapshot to protobuf SurfaceUpdate message."""
    points = [
        pb2.SurfacePoint(
            strike=p.strike,
            moneyness=p.moneyness,
            time_to_expiry=p.time_to_expiry,
            implied_vol=p.implied_vol,
            option_price=p.option_price,
            expiration_date=p.expiration_date,
        )
        for p in snap.points
    ]
    return pb2.SurfaceUpdate(
        update_type=update_type,
        ticker=snap.ticker,
        timestamp_ms=snap.timestamp_ms,
        spot_price=snap.spot_price,
        points=points,
        expirations=snap.expirations,
    )


def instrument_to_proto(
    ticker: str,
    name: str,
    exchange: str = "",
    instrument_type: str = "",
) -> pb2.Instrument:
    return pb2.Instrument(
        ticker=ticker.upper(),
        name=name,
        exchange=exchange,
        instrument_type=instrument_type,
    )


def search_instruments(config: dict, query: str, limit: int) -> list[pb2.Instrument]:
    normalized_query = query.strip()
    capped_limit = max(1, min(limit or 8, MAX_SEARCH_RESULTS))
    normalized_query_lower = normalized_query.lower()

    instruments: list[pb2.Instrument] = []
    instrument_positions: dict[str, int] = {}
    seen: set[str] = set()

    # Seed results with configured instruments so tracked names stay easy to discover.
    for item in config["instruments"]:
        ticker = item["ticker"].upper()
        name = item["name"]
        if normalized_query_lower not in ticker.lower() and normalized_query_lower not in name.lower():
            continue
        instruments.append(instrument_to_proto(ticker=ticker, name=name))
        instrument_positions[ticker] = len(instruments) - 1
        seen.add(ticker)
        if len(instruments) >= capped_limit:
            return instruments

    try:
        search = yf.Search(
            normalized_query,
            max_results=capped_limit,
            news_count=0,
            lists_count=0,
            recommended=0,
            include_cb=False,
            raise_errors=False,
        )
    except Exception as exc:
        logger.warning(f"Ticker search failed for '{normalized_query}': {exc}")
        return instruments

    for quote in search.quotes:
        ticker = str(quote.get("symbol") or "").upper().strip()
        if not ticker:
            continue

        quote_type = str(quote.get("quoteType") or "").upper()
        if quote_type and quote_type not in SUPPORTED_SEARCH_TYPES:
            continue

        exchange = str(quote.get("exchDisp") or quote.get("exchange") or "")
        instrument_type = str(quote.get("typeDisp") or quote_type.title())

        if ticker in instrument_positions:
            existing = instruments[instrument_positions[ticker]]
            if not existing.exchange and exchange:
                existing.exchange = exchange
            if not existing.instrument_type and instrument_type:
                existing.instrument_type = instrument_type
            continue

        if ticker in seen:
            continue

        instruments.append(
            instrument_to_proto(
                ticker=ticker,
                name=str(quote.get("longname") or quote.get("shortname") or ticker),
                exchange=exchange,
                instrument_type=instrument_type,
            )
        )
        seen.add(ticker)

        if len(instruments) >= capped_limit:
            break

    return instruments


class SurfaceManager:
    """
    Manages the latest vol surface snapshots and a registry of client
    subscriptions.  A background thread periodically recomputes surfaces
    for tickers that have at least one subscriber.
    """

    def __init__(self, config: dict):
        self.config = config
        self.defaults = config["defaults"]
        self.update_interval = self.defaults.get("update_interval_seconds", 60)

        # ticker -> latest VolSurfaceSnapshot
        self._surfaces: dict[str, VolSurfaceSnapshot] = {}
        self._lock = threading.Lock()

        # ticker -> set of queue references (one per connected client)
        self._subscribers: dict[str, set] = defaultdict(set)
        self._sub_lock = threading.Lock()

        self._running = False

    # ------------------------------------------------------------------
    # Subscription management
    # ------------------------------------------------------------------

    def subscribe(self, ticker: str, queue) -> VolSurfaceSnapshot | None:
        """Register a client queue for a ticker. Returns current snapshot if available."""
        with self._sub_lock:
            self._subscribers[ticker].add(id(queue))
        with self._lock:
            return self._surfaces.get(ticker)

    def unsubscribe(self, ticker: str, queue):
        with self._sub_lock:
            self._subscribers[ticker].discard(id(queue))

    def active_tickers(self) -> set[str]:
        with self._sub_lock:
            return {t for t, subs in self._subscribers.items() if subs}

    # ------------------------------------------------------------------
    # Background surface computation loop
    # ------------------------------------------------------------------

    def start(self):
        self._running = True
        thread = threading.Thread(target=self._run_loop, daemon=True)
        thread.start()
        logger.info("SurfaceManager background loop started")

    def stop(self):
        self._running = False

    def _run_loop(self):
        while self._running:
            active = self.active_tickers()
            for ticker in active:
                self._recompute(ticker)
            time.sleep(self.update_interval)

    def _recompute(self, ticker: str):
        new_snap = build_surface(
            ticker=ticker,
            risk_free_rate=self.defaults["risk_free_rate"],
            dividend_yield=self.defaults["dividend_yield"],
            moneyness_min=self.defaults["moneyness_min"],
            moneyness_max=self.defaults["moneyness_max"],
        )
        if new_snap is None:
            return

        with self._lock:
            old_snap = self._surfaces.get(ticker)
            self._surfaces[ticker] = new_snap

        # If we had a previous surface, try to send incremental; else snapshot
        if old_snap is not None:
            incremental = compute_incremental_update(old_snap, new_snap)
            if incremental:
                logger.info(f"Incremental update for {ticker}: {len(incremental.points)} changed points")
            # Note: actual dissemination to client queues happens in the servicer
            # via polling; here we just update the stored state.

    def get_latest(self, ticker: str) -> VolSurfaceSnapshot | None:
        with self._lock:
            return self._surfaces.get(ticker)

    def force_compute(self, ticker: str) -> VolSurfaceSnapshot | None:
        """Immediately compute a surface (used on first subscription)."""
        snap = build_surface(
            ticker=ticker,
            risk_free_rate=self.defaults["risk_free_rate"],
            dividend_yield=self.defaults["dividend_yield"],
            moneyness_min=self.defaults["moneyness_min"],
            moneyness_max=self.defaults["moneyness_max"],
        )
        if snap:
            with self._lock:
                self._surfaces[ticker] = snap
        return snap


class VolSurfaceServicer(pb2_grpc.VolSurfaceServiceServicer):
    """gRPC servicer implementing the VolSurfaceService."""

    def __init__(self, manager: SurfaceManager):
        self.manager = manager

    def GetInstruments(self, request, context):
        instruments = [
            instrument_to_proto(ticker=i["ticker"], name=i["name"])
            for i in self.manager.config["instruments"]
        ]
        return pb2.InstrumentList(instruments=instruments)

    def SearchInstruments(self, request, context):
        query = request.query.strip()
        if not query:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "query must not be empty")

        instruments = search_instruments(
            config=self.manager.config,
            query=query,
            limit=request.limit,
        )
        return pb2.InstrumentList(instruments=instruments)

    def SubscribeSurface(self, request_iterator, context):
        """
        Bidirectional streaming RPC.

        Client sends SubscriptionRequests (SUBSCRIBE / UNSUBSCRIBE).
        Server responds with SurfaceUpdates (SNAPSHOT / INCREMENTAL / CLEAR).

        Design decisions (per the Coding Jesus video):
        - On subscribe → send immediate SNAPSHOT
        - On unsubscribe → send CLEAR message so client wipes its cache
        - Periodically re-send full snapshots (simulates "new snapshot" events)
        """
        client_id = context.peer()
        logger.info(f"Client connected: {client_id}")

        subscribed_tickers: set[str] = set()
        # Track last-sent snapshot per ticker to compute incrementals
        last_sent: dict[str, VolSurfaceSnapshot] = {}

        # We need to handle the bidirectional stream. The client sends
        # subscription requests, and we respond with updates.  We'll
        # process requests in a thread and yield updates from the main generator.

        import queue
        update_queue: queue.Queue = queue.Queue()
        stop_event = threading.Event()

        def process_requests():
            try:
                for req in request_iterator:
                    ticker = req.ticker.upper()
                    if req.action == pb2.SubscriptionRequest.SUBSCRIBE:
                        logger.info(f"{client_id} SUBSCRIBE {ticker}")
                        subscribed_tickers.add(ticker)
                        self.manager.subscribe(ticker, update_queue)

                        # Compute and send initial snapshot
                        snap = self.manager.get_latest(ticker)
                        if snap is None:
                            snap = self.manager.force_compute(ticker)
                        if snap:
                            msg = snapshot_to_proto(snap, pb2.SurfaceUpdate.SNAPSHOT)
                            update_queue.put(msg)
                            last_sent[ticker] = snap

                    elif req.action == pb2.SubscriptionRequest.UNSUBSCRIBE:
                        logger.info(f"{client_id} UNSUBSCRIBE {ticker}")
                        subscribed_tickers.discard(ticker)
                        self.manager.unsubscribe(ticker, update_queue)
                        last_sent.pop(ticker, None)

                        # Send CLEAR so client wipes its cache
                        clear_msg = pb2.SurfaceUpdate(
                            update_type=pb2.SurfaceUpdate.CLEAR,
                            ticker=ticker,
                            timestamp_ms=int(time.time() * 1000),
                        )
                        update_queue.put(clear_msg)

            except grpc.RpcError:
                pass
            finally:
                stop_event.set()

        req_thread = threading.Thread(target=process_requests, daemon=True)
        req_thread.start()

        # Periodic update sender
        def periodic_updates():
            while not stop_event.is_set():
                stop_event.wait(timeout=self.manager.update_interval)
                if stop_event.is_set():
                    break
                for ticker in list(subscribed_tickers):
                    new_snap = self.manager.get_latest(ticker)
                    if new_snap is None:
                        continue
                    prev = last_sent.get(ticker)
                    if prev and prev.timestamp_ms == new_snap.timestamp_ms:
                        continue  # no change

                    if prev:
                        inc = compute_incremental_update(prev, new_snap)
                        if inc:
                            msg = snapshot_to_proto(inc, pb2.SurfaceUpdate.INCREMENTAL)
                            update_queue.put(msg)
                        # Occasionally send full snapshot (like a reset event)
                        elif int(time.time()) % 5 == 0:
                            msg = snapshot_to_proto(new_snap, pb2.SurfaceUpdate.SNAPSHOT)
                            update_queue.put(msg)
                    else:
                        msg = snapshot_to_proto(new_snap, pb2.SurfaceUpdate.SNAPSHOT)
                        update_queue.put(msg)

                    last_sent[ticker] = new_snap

        update_thread = threading.Thread(target=periodic_updates, daemon=True)
        update_thread.start()

        # Yield updates to the client
        while not stop_event.is_set() or not update_queue.empty():
            try:
                msg = update_queue.get(timeout=1.0)
                yield msg
            except queue.Empty:
                continue

        # Cleanup
        for ticker in subscribed_tickers:
            self.manager.unsubscribe(ticker, update_queue)
        logger.info(f"Client disconnected: {client_id}")


def serve():
    config = load_config()
    manager = SurfaceManager(config)
    manager.start()

    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    pb2_grpc.add_VolSurfaceServiceServicer_to_server(
        VolSurfaceServicer(manager), server
    )

    host = config["server"]["host"]
    port = config["server"]["port"]
    server.add_insecure_port(f"{host}:{port}")
    server.start()
    logger.info(f"VolStream gRPC server listening on {host}:{port}")

    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        manager.stop()
        server.stop(grace=5)


if __name__ == "__main__":
    serve()
