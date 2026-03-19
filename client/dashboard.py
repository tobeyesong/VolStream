from __future__ import annotations

import html
import tempfile
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from statistics import mean

import plotly.graph_objects as go
import plotly.io as pio

DASHBOARD_PATH = Path(tempfile.gettempdir()) / "volstream_dashboard.html"
AUTO_REFRESH_SECONDS = 10

INK = "#0f172a"
INK_SOFT = "#334155"
MUTED = "#64748b"
LINE = "rgba(148, 163, 184, 0.24)"
SURFACE_BG = "#f8fafc"
PRIMARY = "#1d4ed8"
SECONDARY = "#0f766e"
ACCENT = "#f97316"
HEATMAP = [
    [0.0, "#dbeafe"],
    [0.25, "#93c5fd"],
    [0.55, "#38bdf8"],
    [0.8, "#2563eb"],
    [1.0, "#172554"],
]
SURFACE_SCALE = [
    [0.0, "#e0f2fe"],
    [0.3, "#7dd3fc"],
    [0.6, "#2563eb"],
    [1.0, "#f97316"],
]
PLOT_CONFIG = {
    "displaylogo": False,
    "responsive": True,
    "modeBarButtonsToRemove": [
        "select2d",
        "lasso2d",
        "zoomIn2d",
        "zoomOut2d",
        "autoScale2d",
        "resetScale2d",
    ],
}


def write_dashboard(states: dict[str, object], tickers: list[str]) -> Path:
    DASHBOARD_PATH.write_text(build_dashboard_html(states, tickers), encoding="utf-8")
    return DASHBOARD_PATH


def build_dashboard_html(states: dict[str, object], tickers: list[str]) -> str:
    active_state = next((states[t] for t in tickers if getattr(states[t], "_points", None)), None)
    hero_ticker = active_state.ticker if active_state else tickers[0]
    hero_summary = _build_summary(active_state) if active_state else None

    include_plotlyjs = True
    sections: list[str] = []
    for ticker in tickers:
        section_html, include_plotlyjs = _build_ticker_section(states[ticker], include_plotlyjs)
        sections.append(section_html)

    hero_badges = [
        _badge(f"Streaming {html.escape(', '.join(tickers))}", "primary"),
        _badge(f"Auto-refreshing every {AUTO_REFRESH_SECONDS}s", "secondary"),
    ]
    if hero_summary:
        hero_badges.append(_badge(f"Last snapshot {hero_summary['updated_label']}", "secondary"))

    hero_stats = ""
    if hero_summary:
        hero_stats = """
        <div class="hero-stats">
          {cards}
        </div>
        """.format(
            cards="".join(
                [
                    _stat_card("Spot", _format_money(hero_summary["spot_price"]), hero_ticker),
                    _stat_card(
                        "Front expiry",
                        hero_summary["front_expiry_short"],
                        f"ATM IV {_format_pct(hero_summary['front_atm_iv'])}",
                    ),
                    _stat_card("Surface points", str(hero_summary["points_count"]), "contracts in view"),
                    _stat_card("Tracked expiries", str(hero_summary["expiry_count"]), "live Yahoo chain"),
                ]
            )
        )

    hero_copy = (
        f"""
        <section class="hero">
          <div class="hero-copy card">
            <span class="eyebrow">VolStream</span>
            <h1>Read volatility in layers, not in a point cloud.</h1>
            <p class="lede">
              This dashboard applies the hierarchy from your design PDFs: start with the summary cards,
              scan the heatmap for where IV is elevated, compare the front-month skew, then use the 3D
              surface only as supporting context.
            </p>
            <div class="badge-row">
              {''.join(hero_badges)}
            </div>
            {hero_stats}
          </div>
          <aside class="hero-guide card">
            <span class="eyebrow subtle">Start here</span>
            <h2>How to read {html.escape(hero_ticker)}</h2>
            <ol class="guide-list">
              <li>Use <strong>Surface overview</strong> to spot rich or cheap volatility by expiry.</li>
              <li>Use <strong>Front-month skew</strong> to compare downside and upside pricing.</li>
              <li>Use <strong>ATM term structure</strong> to see whether risk is front-loaded or deferred.</li>
            </ol>
            <div class="hero-note">
              The 3D plot is still available, but it is intentionally pushed down in the hierarchy.
            </div>
          </aside>
        </section>
        """
    )

    bottom_cta = """
    <section class="footer-cta card">
      <span class="eyebrow subtle">Next move</span>
      <h2>Need another symbol?</h2>
      <p>
        Search in a terminal with <code>make search SEARCH_QUERY=tesla</code>, then relaunch the client
        with <code>make client TICKER=TSLA</code> to swap the live dashboard.
      </p>
    </section>
    """

    return f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="{AUTO_REFRESH_SECONDS}" />
    <title>VolStream Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Manrope:wght@400;500;700;800&display=swap" rel="stylesheet" />
    <style>
      :root {{
        --bg: #eef4ff;
        --bg-accent: #fff7ed;
        --card: rgba(255, 255, 255, 0.82);
        --card-strong: rgba(255, 255, 255, 0.94);
        --ink: {INK};
        --ink-soft: {INK_SOFT};
        --muted: {MUTED};
        --line: {LINE};
        --primary: {PRIMARY};
        --secondary: {SECONDARY};
        --accent: {ACCENT};
        --shadow: 0 24px 60px rgba(15, 23, 42, 0.08);
        --radius-xl: 28px;
        --radius-lg: 22px;
        --radius-md: 18px;
        --space-1: 8px;
        --space-2: 12px;
        --space-3: 16px;
        --space-4: 24px;
        --space-5: 32px;
        --space-6: 48px;
      }}

      * {{
        box-sizing: border-box;
      }}

      body {{
        margin: 0;
        min-height: 100vh;
        color: var(--ink);
        font-family: "Manrope", "Avenir Next", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(96, 165, 250, 0.25), transparent 36%),
          radial-gradient(circle at top right, rgba(249, 115, 22, 0.16), transparent 28%),
          linear-gradient(180deg, var(--bg), #f8fafc 48%, #ffffff 100%);
      }}

      .page {{
        width: min(1240px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 64px;
      }}

      .card {{
        position: relative;
        overflow: hidden;
        background: var(--card);
        border: 1px solid rgba(255, 255, 255, 0.6);
        border-radius: var(--radius-xl);
        box-shadow: var(--shadow);
        backdrop-filter: blur(20px);
      }}

      .card::before {{
        content: "";
        position: absolute;
        inset: 0 auto auto 0;
        width: 160px;
        height: 160px;
        background: radial-gradient(circle, rgba(255, 255, 255, 0.55), transparent 70%);
        pointer-events: none;
      }}

      .hero {{
        display: grid;
        grid-template-columns: minmax(0, 1.55fr) minmax(320px, 0.95fr);
        gap: var(--space-4);
        align-items: stretch;
      }}

      .hero-copy,
      .hero-guide,
      .ticker-section,
      .footer-cta {{
        padding: var(--space-5);
        animation: fade-up 480ms ease both;
      }}

      .eyebrow {{
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-size: 0.78rem;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--primary);
        font-weight: 800;
      }}

      .eyebrow.subtle {{
        color: var(--secondary);
      }}

      h1,
      h2,
      h3 {{
        margin: 0;
        font-family: "Fraunces", Georgia, serif;
        font-weight: 600;
        letter-spacing: -0.04em;
      }}

      h1 {{
        margin-top: var(--space-3);
        max-width: 11ch;
        font-size: clamp(2.8rem, 5vw, 4.6rem);
        line-height: 0.92;
      }}

      h2 {{
        font-size: clamp(1.55rem, 2vw, 2.25rem);
        line-height: 1;
      }}

      h3 {{
        font-size: 1.15rem;
        line-height: 1.1;
      }}

      .lede,
      .section-copy,
      .hero-note,
      .footer-cta p,
      .empty-copy,
      .metric-detail {{
        color: var(--ink-soft);
      }}

      .lede {{
        max-width: 60ch;
        margin: var(--space-4) 0 0;
        font-size: 1.05rem;
        line-height: 1.75;
      }}

      .badge-row {{
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        margin-top: var(--space-4);
      }}

      .badge {{
        display: inline-flex;
        align-items: center;
        padding: 10px 16px;
        border-radius: 999px;
        font-size: 0.92rem;
        font-weight: 700;
      }}

      .badge.primary {{
        color: #ffffff;
        background: linear-gradient(135deg, var(--primary), #1e40af);
      }}

      .badge.secondary {{
        color: var(--ink-soft);
        background: rgba(226, 232, 240, 0.8);
      }}

      .hero-stats {{
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: var(--space-3);
        margin-top: var(--space-5);
      }}

      .stat-card {{
        padding: 18px;
        border-radius: var(--radius-md);
        background: var(--card-strong);
        border: 1px solid rgba(148, 163, 184, 0.16);
      }}

      .stat-label {{
        display: block;
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }}

      .stat-value {{
        display: block;
        margin-top: 10px;
        font-size: clamp(1.3rem, 2vw, 1.9rem);
        line-height: 1.05;
        font-weight: 800;
        color: var(--ink);
      }}

      .stat-meta {{
        display: block;
        margin-top: 8px;
        color: var(--ink-soft);
        font-size: 0.92rem;
      }}

      .guide-list {{
        margin: var(--space-4) 0 0;
        padding-left: 20px;
        color: var(--ink-soft);
        line-height: 1.75;
      }}

      .hero-note {{
        margin-top: var(--space-4);
        padding: 18px 20px;
        border-radius: var(--radius-md);
        background: linear-gradient(135deg, rgba(219, 234, 254, 0.82), rgba(240, 249, 255, 0.94));
        border: 1px solid rgba(96, 165, 250, 0.16);
      }}

      .ticker-stack {{
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        margin-top: var(--space-4);
      }}

      .ticker-section {{
        background: var(--card-strong);
      }}

      .section-header {{
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: var(--space-3);
        align-items: end;
      }}

      .section-copy {{
        margin: 12px 0 0;
        max-width: 68ch;
        line-height: 1.7;
      }}

      .metric-strip {{
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: var(--space-3);
        margin-top: var(--space-4);
      }}

      .mini-metric {{
        padding: 18px;
        border-radius: var(--radius-md);
        background: linear-gradient(180deg, rgba(248, 250, 252, 0.92), rgba(255, 255, 255, 0.96));
        border: 1px solid rgba(148, 163, 184, 0.16);
      }}

      .metric-value {{
        display: block;
        margin-top: 10px;
        font-size: 1.5rem;
        font-weight: 800;
        color: var(--ink);
      }}

      .chart-grid {{
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.8fr);
        gap: var(--space-4);
        margin-top: var(--space-5);
      }}

      .chart-card,
      .table-card,
      .empty-state {{
        padding: 22px;
        border-radius: var(--radius-lg);
        background: #ffffff;
        border: 1px solid rgba(148, 163, 184, 0.16);
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.04);
      }}

      .chart-card.wide,
      .table-card {{
        grid-column: 1 / -1;
      }}

      .chart-intro {{
        margin: 8px 0 16px;
        color: var(--ink-soft);
        line-height: 1.65;
      }}

      .chart-shell > div {{
        width: 100%;
      }}

      table {{
        width: 100%;
        border-collapse: collapse;
      }}

      thead th {{
        padding-bottom: 10px;
        border-bottom: 1px solid var(--line);
        font-size: 0.82rem;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        text-align: left;
        color: var(--muted);
      }}

      tbody td {{
        padding: 14px 0;
        border-bottom: 1px solid rgba(226, 232, 240, 0.74);
        color: var(--ink-soft);
      }}

      tbody tr:last-child td {{
        border-bottom: 0;
      }}

      td strong {{
        color: var(--ink);
      }}

      .footer-cta {{
        margin-top: var(--space-4);
        text-align: left;
        background: linear-gradient(135deg, rgba(255, 247, 237, 0.92), rgba(255, 255, 255, 0.95));
      }}

      .footer-cta p {{
        margin: 14px 0 0;
        max-width: 60ch;
        line-height: 1.7;
      }}

      code {{
        padding: 3px 8px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.06);
        font-size: 0.92em;
      }}

      .empty-state {{
        margin-top: var(--space-5);
        background: linear-gradient(135deg, rgba(219, 234, 254, 0.62), rgba(255, 255, 255, 0.94));
      }}

      .empty-title {{
        margin-top: 8px;
      }}

      .empty-copy {{
        margin: 14px 0 0;
        max-width: 60ch;
        line-height: 1.7;
      }}

      @keyframes fade-up {{
        from {{
          opacity: 0;
          transform: translateY(12px);
        }}
        to {{
          opacity: 1;
          transform: translateY(0);
        }}
      }}

      @media (max-width: 1080px) {{
        .hero,
        .chart-grid {{
          grid-template-columns: 1fr;
        }}

        .hero-stats,
        .metric-strip {{
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }}
      }}

      @media (max-width: 720px) {{
        .page {{
          width: min(100vw - 20px, 1240px);
          padding-top: 16px;
        }}

        .hero-copy,
        .hero-guide,
        .ticker-section,
        .footer-cta {{
          padding: 22px;
        }}

        h1 {{
          max-width: none;
          font-size: 2.4rem;
        }}

        .hero-stats,
        .metric-strip {{
          grid-template-columns: 1fr;
        }}
      }}
    </style>
  </head>
  <body>
    <main class="page">
      {hero_copy}
      <div class="ticker-stack">
        {''.join(sections)}
      </div>
      {bottom_cta}
    </main>
  </body>
</html>
"""


def _build_ticker_section(state: object, include_plotlyjs: bool) -> tuple[str, bool]:
    ticker = html.escape(state.ticker)
    points = list(state._points.values())
    if not points:
        return (
            f"""
            <section class="ticker-section card">
              <div class="section-header">
                <div>
                  <span class="eyebrow subtle">Live surface</span>
                  <h2>{ticker}</h2>
                  <p class="section-copy">
                    The dashboard is ready, but Yahoo Finance has not returned the first usable option
                    surface yet. This view will fill in automatically once a snapshot arrives.
                  </p>
                </div>
              </div>
              <div class="empty-state">
                <span class="eyebrow subtle">Waiting on data</span>
                <h3 class="empty-title">No snapshot yet for {ticker}</h3>
                <p class="empty-copy">
                  Keep this tab open. The client is still subscribed and will refresh the page as soon
                  as the first option chain is processed.
                </p>
              </div>
            </section>
            """,
            include_plotlyjs,
        )

    summary = _build_summary(state)
    heatmap_fig = _build_surface_overview(points, ticker)
    term_fig = _build_term_structure(points, ticker)
    skew_fig = _build_front_skew(points, ticker)
    surface_fig = _build_surface_context(points, ticker)

    heatmap_html = _plot_html(heatmap_fig, include_plotlyjs)
    include_plotlyjs = False
    term_html = _plot_html(term_fig, include_plotlyjs)
    skew_html = _plot_html(skew_fig, include_plotlyjs)
    surface_html = _plot_html(surface_fig, include_plotlyjs)

    top_rows = "".join(_top_contract_rows(points))

    return (
        f"""
        <section class="ticker-section card">
          <div class="section-header">
            <div>
              <span class="eyebrow subtle">Live surface</span>
              <h2>{ticker}</h2>
              <p class="section-copy">
                Focus on the top row first. It answers the three questions most users actually have:
                where volatility is rich, how the front month is skewed, and whether ATM risk is
                rising or falling across expiries.
              </p>
            </div>
            <div class="badge-row">
              {_badge(summary['updated_label'], 'secondary')}
            </div>
          </div>

          <div class="metric-strip">
            {_mini_metric('Spot price', _format_money(summary['spot_price']), 'current underlying')}
            {_mini_metric('Front ATM IV', _format_pct(summary['front_atm_iv']), summary['front_expiry_long'])}
            {_mini_metric('Average IV', _format_pct(summary['average_iv']), f"{summary['points_count']} contracts")}
            {_mini_metric('Vol range', f"{_format_pct(summary['min_iv'])} to {_format_pct(summary['max_iv'])}", f"{summary['expiry_count']} expiries")}
          </div>

          <div class="chart-grid">
            <article class="chart-card wide">
              <span class="eyebrow subtle">1. Surface overview</span>
              <h3>Heatmap of implied volatility by expiry and moneyness</h3>
              <p class="chart-intro">
                This replaces the old point cloud as the primary view. Darker cells indicate richer
                implied volatility for that zone of the surface.
              </p>
              <div class="chart-shell">{heatmap_html}</div>
            </article>

            <article class="chart-card">
              <span class="eyebrow subtle">2. Front-month skew</span>
              <h3>{html.escape(summary['front_expiry_short'])}</h3>
              <p class="chart-intro">
                Read left versus right to compare lower-strike and higher-strike calls around the front expiry.
              </p>
              <div class="chart-shell">{skew_html}</div>
            </article>

            <article class="chart-card">
              <span class="eyebrow subtle">3. ATM term structure</span>
              <h3>How ATM IV changes across expiries</h3>
              <p class="chart-intro">
                This view shows whether implied risk is concentrated near term or deferred into longer dates.
              </p>
              <div class="chart-shell">{term_html}</div>
            </article>

            <article class="chart-card">
              <span class="eyebrow subtle">4. 3D context</span>
              <h3>Surface cloud</h3>
              <p class="chart-intro">
                The original 3D surface remains available as context, but it now supports the clearer 2D reads above.
              </p>
              <div class="chart-shell">{surface_html}</div>
            </article>

            <article class="table-card">
              <span class="eyebrow subtle">5. Richest contracts</span>
              <h3>Contracts with the highest implied volatility</h3>
              <p class="chart-intro">
                Useful when you want a concrete list after identifying a hot zone in the heatmap.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Expiry</th>
                    <th>Moneyness</th>
                    <th>Strike</th>
                    <th>IV</th>
                    <th>Price</th>
                  </tr>
                </thead>
                <tbody>
                  {top_rows}
                </tbody>
              </table>
            </article>
          </div>
        </section>
        """,
        include_plotlyjs,
    )


def _build_summary(state: object) -> dict[str, object]:
    points = list(state._points.values())
    by_expiry = _group_points_by_expiry(points)
    ordered_expiries = sorted(by_expiry, key=_parse_expiration)
    front_expiry = ordered_expiries[0]
    front_points = by_expiry[front_expiry]
    front_atm = _nearest_atm(front_points)
    ivs = [point["implied_vol"] for point in points]

    return {
        "spot_price": state.spot_price,
        "points_count": len(points),
        "expiry_count": len(ordered_expiries),
        "front_expiry_short": _format_expiration(front_expiry, short=True),
        "front_expiry_long": _format_expiration(front_expiry, short=False),
        "front_atm_iv": front_atm["implied_vol"],
        "average_iv": mean(ivs),
        "min_iv": min(ivs),
        "max_iv": max(ivs),
        "updated_label": _format_timestamp(state.timestamp_ms),
    }


def _build_surface_overview(points: list[dict], ticker: str) -> go.Figure:
    by_expiry = _group_points_by_expiry(points)
    ordered_expiries = sorted(by_expiry, key=_parse_expiration)
    expiry_labels = [_format_expiration(expiry, short=True) for expiry in ordered_expiries]
    bucket_values = sorted(
        {
            round(round(point["moneyness"] / 0.02) * 0.02, 2)
            for point in points
        }
    )

    z_matrix: list[list[float | None]] = []
    for bucket in bucket_values:
        row = []
        for expiry in ordered_expiries:
            bucket_points = [
                point["implied_vol"]
                for point in by_expiry[expiry]
                if round(round(point["moneyness"] / 0.02) * 0.02, 2) == bucket
            ]
            row.append(mean(bucket_points) if bucket_points else None)
        z_matrix.append(row)

    fig = go.Figure(
        data=[
            go.Heatmap(
                x=expiry_labels,
                y=bucket_values,
                z=z_matrix,
                colorscale=HEATMAP,
                colorbar=dict(title="IV", tickformat=".0%"),
                hovertemplate="Expiry: %{x}<br>Moneyness: %{y:.2f}x<br>Average IV: %{z:.1%}<extra></extra>",
            )
        ]
    )
    layout = _base_layout(f"{ticker}: live surface overview")
    layout["margin"] = dict(l=70, r=26, t=56, b=54)
    fig.update_layout(**layout)
    fig.update_xaxes(title="Expiry", gridcolor=LINE, showline=False)
    fig.update_yaxes(title="Moneyness (strike / spot)", gridcolor=LINE, showline=False)
    return fig


def _build_term_structure(points: list[dict], ticker: str) -> go.Figure:
    by_expiry = _group_points_by_expiry(points)
    ordered_expiries = sorted(by_expiry, key=_parse_expiration)
    atm_points = [_nearest_atm(by_expiry[expiry]) for expiry in ordered_expiries]

    fig = go.Figure(
        data=[
            go.Scatter(
                x=[_format_expiration(expiry, short=True) for expiry in ordered_expiries],
                y=[point["implied_vol"] for point in atm_points],
                mode="lines+markers",
                line=dict(color=SECONDARY, width=3),
                marker=dict(size=9, color=SECONDARY, line=dict(color="#ecfeff", width=2)),
                fill="tozeroy",
                fillcolor="rgba(15, 118, 110, 0.12)",
                hovertemplate="Expiry: %{x}<br>ATM IV: %{y:.1%}<extra></extra>",
            )
        ]
    )
    fig.update_layout(**_base_layout(f"{ticker}: ATM term structure"))
    fig.update_xaxes(title="Expiry", gridcolor=LINE)
    fig.update_yaxes(title="ATM IV", tickformat=".0%", gridcolor=LINE)
    return fig


def _build_front_skew(points: list[dict], ticker: str) -> go.Figure:
    by_expiry = _group_points_by_expiry(points)
    front_expiry = min(by_expiry, key=_parse_expiration)
    front_points = sorted(by_expiry[front_expiry], key=lambda point: point["moneyness"])

    fig = go.Figure(
        data=[
            go.Scatter(
                x=[point["moneyness"] for point in front_points],
                y=[point["implied_vol"] for point in front_points],
                mode="lines+markers",
                line=dict(color=PRIMARY, width=3),
                marker=dict(size=7, color=PRIMARY, line=dict(color="#dbeafe", width=1.5)),
                fill="tozeroy",
                fillcolor="rgba(37, 99, 235, 0.12)",
                hovertemplate="Moneyness: %{x:.2f}x<br>IV: %{y:.1%}<extra></extra>",
            )
        ]
    )
    fig.update_layout(
        **_base_layout(f"{ticker}: front-month skew"),
        shapes=[
            dict(
                type="line",
                x0=1.0,
                x1=1.0,
                y0=0,
                y1=1,
                xref="x",
                yref="paper",
                line=dict(color="rgba(249, 115, 22, 0.45)", width=2, dash="dot"),
            )
        ],
    )
    fig.update_xaxes(title="Moneyness", gridcolor=LINE)
    fig.update_yaxes(title="Implied volatility", tickformat=".0%", gridcolor=LINE)
    return fig


def _build_surface_context(points: list[dict], ticker: str) -> go.Figure:
    fig = go.Figure(
        data=[
            go.Scatter3d(
                x=[point["time_to_expiry"] for point in points],
                y=[point["moneyness"] for point in points],
                z=[point["implied_vol"] for point in points],
                mode="markers",
                marker=dict(
                    size=4,
                    color=[point["implied_vol"] for point in points],
                    colorscale=SURFACE_SCALE,
                    opacity=0.8,
                    colorbar=dict(title="IV", tickformat=".0%"),
                ),
                text=[
                    (
                        f"Expiry: {point['expiration_date']}<br>"
                        f"Strike: {point['strike']:.2f}<br>"
                        f"Moneyness: {point['moneyness']:.3f}x<br>"
                        f"IV: {point['implied_vol']:.2%}<br>"
                        f"Option price: {_format_money(point['option_price'])}"
                    )
                    for point in points
                ],
                hoverinfo="text",
            )
        ]
    )
    layout = _base_layout(f"{ticker}: 3D surface context")
    layout["scene"] = dict(
        xaxis_title="Time to expiry (years)",
        yaxis_title="Moneyness",
        zaxis_title="IV",
        xaxis=dict(backgroundcolor=SURFACE_BG, gridcolor=LINE, zerolinecolor=LINE),
        yaxis=dict(backgroundcolor=SURFACE_BG, gridcolor=LINE, zerolinecolor=LINE),
        zaxis=dict(backgroundcolor=SURFACE_BG, gridcolor=LINE, zerolinecolor=LINE, tickformat=".0%"),
        camera=dict(eye=dict(x=1.4, y=1.3, z=0.95)),
    )
    layout["margin"] = dict(l=0, r=0, t=56, b=0)
    fig.update_layout(**layout)
    return fig


def _plot_html(fig: go.Figure, include_plotlyjs: bool) -> str:
    return pio.to_html(
        fig,
        full_html=False,
        include_plotlyjs="cdn" if include_plotlyjs else False,
        config=PLOT_CONFIG,
        default_width="100%",
    )


def _top_contract_rows(points: list[dict]) -> list[str]:
    rows = []
    ranked = sorted(
        points,
        key=lambda point: (point["implied_vol"], -point["option_price"]),
        reverse=True,
    )[:8]
    for point in ranked:
        rows.append(
            """
            <tr>
              <td><strong>{expiry}</strong></td>
              <td>{moneyness}</td>
              <td>{strike}</td>
              <td>{iv}</td>
              <td>{price}</td>
            </tr>
            """.format(
                expiry=html.escape(_format_expiration(point["expiration_date"], short=True)),
                moneyness=f"{point['moneyness']:.2f}x",
                strike=_format_money(point["strike"]),
                iv=_format_pct(point["implied_vol"]),
                price=_format_money(point["option_price"]),
            )
        )
    return rows


def _group_points_by_expiry(points: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for point in points:
        grouped[point["expiration_date"]].append(point)
    return grouped


def _nearest_atm(points: list[dict]) -> dict:
    return min(points, key=lambda point: abs(point["moneyness"] - 1.0))


def _base_layout(title: str) -> dict:
    return {
        "title": dict(text=title, x=0.02, xanchor="left", font=dict(size=19, color=INK)),
        "template": "none",
        "paper_bgcolor": "rgba(0,0,0,0)",
        "plot_bgcolor": SURFACE_BG,
        "font": dict(family="Manrope, Avenir Next, Segoe UI, sans-serif", size=13, color=INK),
        "margin": dict(l=64, r=22, t=56, b=50),
    }


def _badge(text: str, variant: str) -> str:
    return f'<span class="badge {variant}">{html.escape(text)}</span>'


def _stat_card(label: str, value: str, meta: str) -> str:
    return f"""
    <div class="stat-card">
      <span class="stat-label">{html.escape(label)}</span>
      <span class="stat-value">{html.escape(value)}</span>
      <span class="stat-meta">{html.escape(meta)}</span>
    </div>
    """


def _mini_metric(label: str, value: str, detail: str) -> str:
    return f"""
    <div class="mini-metric">
      <span class="stat-label">{html.escape(label)}</span>
      <span class="metric-value">{html.escape(value)}</span>
      <span class="metric-detail">{html.escape(detail)}</span>
    </div>
    """


def _format_money(value: float) -> str:
    return f"${value:,.2f}"


def _format_pct(value: float) -> str:
    return f"{value:.1%}"


def _format_timestamp(timestamp_ms: int) -> str:
    if not timestamp_ms:
        return "Waiting for first snapshot"
    return datetime.fromtimestamp(timestamp_ms / 1000).strftime("Updated %b %d at %I:%M:%S %p")


def _parse_expiration(expiration: str) -> datetime:
    return datetime.strptime(expiration, "%Y-%m-%d")


def _format_expiration(expiration: str, short: bool) -> str:
    date_value = _parse_expiration(expiration)
    if short:
        return date_value.strftime("%b %d")
    return date_value.strftime("%b %d, %Y")
