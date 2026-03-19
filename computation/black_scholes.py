"""
Black-Scholes implied volatility solver.

Uses scipy's Brent method to invert the BS call price formula and back out
the implied volatility from a market-observed option price.
"""

import numpy as np
from scipy.stats import norm
from scipy.optimize import brentq


def bs_call_price(S: float, K: float, T: float, r: float, q: float, sigma: float) -> float:
    """
    Black-Scholes European call option price.

    Parameters
    ----------
    S : float – Spot price of the underlying
    K : float – Strike price
    T : float – Time to expiration in years
    r : float – Risk-free interest rate (annualised)
    q : float – Continuous dividend yield (annualised)
    sigma : float – Volatility (annualised)

    Returns
    -------
    float – Theoretical call price
    """
    if T <= 0 or sigma <= 0:
        return max(S * np.exp(-q * T) - K * np.exp(-r * T), 0.0)

    d1 = (np.log(S / K) + (r - q + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
    d2 = d1 - sigma * np.sqrt(T)

    price = S * np.exp(-q * T) * norm.cdf(d1) - K * np.exp(-r * T) * norm.cdf(d2)
    return price


def implied_volatility(
    market_price: float,
    S: float,
    K: float,
    T: float,
    r: float,
    q: float,
    vol_low: float = 1e-6,
    vol_high: float = 5.0,
) -> float | None:
    """
    Compute implied volatility by inverting the BS formula using Brent's method.

    Returns None if the solver fails (e.g. the market price is outside the
    no-arbitrage bounds).

    Parameters
    ----------
    market_price : float – Observed call option price
    S, K, T, r, q : float – Standard BS inputs
    vol_low, vol_high : float – Bracket for the root search

    Returns
    -------
    float | None – Implied volatility, or None if no solution
    """
    if T <= 0 or market_price <= 0:
        return None

    intrinsic = max(S * np.exp(-q * T) - K * np.exp(-r * T), 0.0)
    if market_price < intrinsic - 1e-8:
        return None  # Below no-arbitrage bound

    def objective(sigma: float) -> float:
        return bs_call_price(S, K, T, r, q, sigma) - market_price

    try:
        # Check that the bracket actually contains a sign change
        f_low = objective(vol_low)
        f_high = objective(vol_high)
        if f_low * f_high > 0:
            return None
        iv = brentq(objective, vol_low, vol_high, xtol=1e-8, maxiter=200)
        return iv
    except (ValueError, RuntimeError):
        return None


def bs_greeks(S: float, K: float, T: float, r: float, q: float, sigma: float) -> dict:
    """
    Compute common option Greeks (bonus extension).

    Returns dict with keys: delta, gamma, vega, theta, rho.
    """
    if T <= 0 or sigma <= 0:
        return {"delta": 0, "gamma": 0, "vega": 0, "theta": 0, "rho": 0}

    sqrt_T = np.sqrt(T)
    d1 = (np.log(S / K) + (r - q + 0.5 * sigma ** 2) * T) / (sigma * sqrt_T)
    d2 = d1 - sigma * sqrt_T

    delta = np.exp(-q * T) * norm.cdf(d1)
    gamma = np.exp(-q * T) * norm.pdf(d1) / (S * sigma * sqrt_T)
    vega = S * np.exp(-q * T) * norm.pdf(d1) * sqrt_T / 100  # per 1% move
    theta = (
        -S * np.exp(-q * T) * norm.pdf(d1) * sigma / (2 * sqrt_T)
        - r * K * np.exp(-r * T) * norm.cdf(d2)
        + q * S * np.exp(-q * T) * norm.cdf(d1)
    ) / 365  # per day
    rho = K * T * np.exp(-r * T) * norm.cdf(d2) / 100  # per 1% move

    return {
        "delta": delta,
        "gamma": gamma,
        "vega": vega,
        "theta": theta,
        "rho": rho,
    }
