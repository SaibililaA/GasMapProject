import os
import re
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

EIA_API_BASE_URL = "https://api.eia.gov/v2"
EIA_API_KEY = os.environ.get(
    "EIA_API_KEY",
    "o0LCzr8Uv2a8h3TCYo0NaOWbtop9TXlfqLNyxTOk",
)

# Petroleum (Retail) dataset
EIA_WEEKLY_RETAIL_GAS_DIESEL_PATH = "/petroleum/pri/gnd/data/"

# NOTE:
# EIA's retail gasoline/diesel schema can vary across API versions.
# We keep this endpoint, but parse it defensively and try a couple of
# facet/series keys to reliably extract gasoline + diesel values.


ZIP_RE = re.compile(r"\b(\d{5})(?:-\d{4})?\b")


# Minimal, hardcoded state -> PADD mapping (PADD as used by EIA)
#
# PADDs:
# 1: New England (CT, ME, MA, NH, RI, VT) + Central (IL, IN, IA, KS, MI, MN, MO, NE, ND, OH, SD, WI)
# 2: Midwest
# 3: East Coast / Gulf? (actually East Coast)
# 4: Rocky Mountain
# 5: West Coast
#
# For simplicity, we map each state to the standard EIA PADD number.
STATE_TO_PADD = {
    # PADD 1
    "CT": "R1",
    "ME": "R1",
    "MA": "R1",
    "NH": "R1",
    "RI": "R1",
    "VT": "R1",
    "IL": "R1",
    "IN": "R1",
    "IA": "R1",
    "KS": "R1",
    "MI": "R1",
    "MN": "R1",
    "MO": "R1",
    "NE": "R1",
    "ND": "R1",
    "OH": "R1",
    "SD": "R1",
    "WI": "R1",

    # PADD 2 (note: EIA numbering uses R2 for Midwest)
    "AK": "R5",

    # PADD 3
    "DE": "R3",
    "DC": "R3",
    "FL": "R3",
    "GA": "R3",
    "MD": "R3",
    "NC": "R3",
    "SC": "R3",
    "VA": "R3",
    "WV": "R3",

    # PADD 4
    "CO": "R4",
    "ID": "R4",
    "MT": "R4",
    "UT": "R4",
    "WY": "R4",

    # PADD 5
    "AL": "R3",
    "AR": "R2",
    "AZ": "R5",
    "CA": "R5",
    "CO2": "R4",
    "FL2": "R3",
    "HI": "R5",
    "LA": "R3",
    "MA2": "R1",
    "MS": "R3",
    "MT2": "R4",
    "NV": "R5",
    "NM": "R4",
    "NY": "R1",
    "OK": "R2",
    "OR": "R5",
    "PA": "R1",
    "TN": "R3",
    "TX": "R3",
    "WA": "R5",

    # Remaining commonly-missed states
    "NY2": "R1",
    "KY": "R1",
    "LA2": "R3",
    "NJ": "R1",
    "NM2": "R4",
    "SC2": "R3",
    "WA2": "R5",
    "ID2": "R4",
    "MN2": "R1",
}


def extract_state_from_zip(zip_code: str) -> str | None:
    """Best-effort state inference from ZIP.

    Without an external ZIP->state lookup, accuracy will be limited.
    We keep this stub returning None so we can fall back to requiring lat/lng.
    """
    return None


def map_lat_lng_to_padd(lat: float, lng: float) -> str:
    """Fallback PADD mapping when we don't have a precise ZIP->state.

    Uses a crude rule: the Continental US defaults to PADD 1/3/4/5 based on longitude bands.
    This is not perfect but enables the UI to function.
    """
    # US longitude bands (approx)
    # East: <= -93, Central: -93..-100, Rockies: -100..-115, West: > -115
    if lat < 24:
        # unlikely for your station set, but keeps something reasonable
        return "R3"

    if lng > -115:
        return "R5"  # West Coast
    if -115 >= lng > -100:
        return "R4"  # Rocky Mountain
    if -100 >= lng > -93:
        return "R1"  # Central (approx)
    return "R3"  # East/Gulf (approx)


def fetch_eia_weekly_retail_gas_diesel_latest(padd: str) -> dict:
    def do_request(params: dict) -> dict:
        url = f"{EIA_API_BASE_URL}{EIA_WEEKLY_RETAIL_GAS_DIESEL_PATH}"
        r = requests.get(url, params=params, timeout=30)
        if not r.ok:
            raise requests.HTTPError(f"EIA returned {r.status_code}: {(r.text or '')[:800]}")
        return r.json()

    def extract_items(payload: dict) -> list[dict]:
        return (
            payload.get("response", {}).get("data")
            or payload.get("data")
            or payload.get("result")
            or []
        )

    def parse_num(v):
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v)
            except Exception:
                return None
        return None

    def latest_period_from_items(items: list[dict]):
        if not items:
            return None
        # EIA returns items sorted by period desc when requested.
        return items[0].get("period") or items[0].get("time") or items[0].get("periodName")

    # 1) Prefer region-filtered queries (fast) if they work
    candidate_params = [
        {
            "api_key": EIA_API_KEY,
            "frequency": "weekly",
            "data[0]": "value",
            "facets[duoarea][]": padd,
            "sort[0][column]": "period",
            "sort[0][direction]": "desc",
            "offset": 0,
            "length": 5000,
        },
        {
            "api_key": EIA_API_KEY,
            "frequency": "weekly",
            "data[0]": "value",
            "facets[padd][]": padd,
            "sort[0][column]": "period",
            "sort[0][direction]": "desc",
            "offset": 0,
            "length": 5000,
        },
        {
            "api_key": EIA_API_KEY,
            "frequency": "weekly",
            "data[0]": "value",
            "facets[area][]": padd,
            "sort[0][column]": "period",
            "sort[0][direction]": "desc",
            "offset": 0,
            "length": 5000,
        },
    ]

    last_payload = None

    def extract_prices_from_items(items: list[dict], want_padd: str):
        # Use only latest period items
        latest_period = latest_period_from_items(items)
        if latest_period is None:
            return None

        latest_items = [
            it for it in items
            if it.get("period") == latest_period or it.get("time") == latest_period
        ]
        if not latest_items:
            return None

        # If EIA returns multiple regions even within a broad query, pick the one matching padd
        # The observed field is `duoarea` like 'NUS' or possibly 'R5' for regions.
        def duo_match(it):
            duo = it.get("duoarea")
            return duo == want_padd

        region_items = [it for it in latest_items if duo_match(it)]
        if region_items:
            latest_items = region_items

        results = {
            "regular": None,
            "midgrade": None,
            "premium": None,
            "diesel": None,
        }

        for it in latest_items:
            value = parse_num(it.get("value"))
            if value is None:
                continue

            product_name = str(it.get("product-name") or it.get("product") or "").lower()
            series_desc = str(it.get("series-description") or "").lower()
            text = f"{product_name} {series_desc}"

            # Diesel
            if results["diesel"] is None and "diesel" in text:
                # Avoid matching gasoline lines
                if "diesel" in text and "gasoline" not in text:
                    results["diesel"] = value

            # Gasoline grades
            if "gasoline" in text:
                if results["regular"] is None and "regular" in text:
                    results["regular"] = value
                if results["midgrade"] is None and "midgrade" in text:
                    results["midgrade"] = value
                if results["premium"] is None and "premium" in text:
                    results["premium"] = value

        if all(results[k] is None for k in results.keys()):
            return None

        # If only diesel found, still return it; if only gasoline grade found,
        # fill missing gasoline grades with the found grade to keep UI working.
        gasoline_vals = [results["regular"], results["midgrade"], results["premium"]]
        found_gas = next((v for v in gasoline_vals if v is not None), None)
        for k in ("regular", "midgrade", "premium"):
            if results[k] is None and found_gas is not None:
                results[k] = found_gas

        if results["diesel"] is None:
            # if diesel missing but gasoline present, don't fabricate diesel; keep None
            pass

        def mapped(v):
            return {"today": v, "todayLow": v, "currency": "USD"}

        out = {}
        for k in ("regular", "midgrade", "premium"):
            if results[k] is not None:
                out[k] = mapped(results[k])

        if results["diesel"] is not None:
            out["diesel"] = mapped(results["diesel"])

        # Ensure required keys exist for frontend; if missing, frontend will show N/A
        for k in ("regular", "midgrade", "premium", "diesel"):
            if k not in out:
                out[k] = {"today": None, "todayLow": None, "currency": "USD"}

        return out, latest_period

    # Try region-filtered first
    for params in candidate_params:
        try:
            payload = do_request(params)
            last_payload = payload
            items = extract_items(payload)
            if not items:
                continue
            extracted = extract_prices_from_items(items, padd)
            if extracted is None:
                continue
            out, latest_period = extracted
            return {**out, "_diagnostics": {"padd": padd, "latest_period": latest_period, "used_params": {k: v for k, v in params.items() if k.startswith('facets')}}}
        except Exception:
            continue

    # 2) Broad fallback (verified to return data). Then parse latest items.
    broad_params = {
        "api_key": EIA_API_KEY,
        "frequency": "weekly",
        "data[0]": "value",
        "sort[0][column]": "period",
        "sort[0][direction]": "desc",
        "offset": 0,
        "length": 2000,
    }

    payload = do_request(broad_params)
    items = extract_items(payload)
    last_payload = payload

    extracted = extract_prices_from_items(items, padd)
    if extracted is None:
        return {"_diagnostics": {"message": "EIA returned no usable gas/diesel items.", "padd": padd, "raw": last_payload}}

    out, latest_period = extracted
    return {**out, "_diagnostics": {"padd": padd, "latest_period": latest_period, "used_params": {"broad": True}}}




@app.get("/api/health")
def health():
    return jsonify({"ok": True}), 200


@app.get("/api/gas-prices")
def gas_prices():
    zip_code = request.args.get("zip")

    if not zip_code:
        return jsonify({"error": "Missing zip"}), 400

    m = ZIP_RE.match(zip_code)
    if not m:
        return jsonify({"error": "Invalid zip"}), 400

    lat = request.args.get("lat")
    lng = request.args.get("lng")

    if lat is None or lng is None:
        # Without lat/lng or a ZIP->state service, we can't map to PADD reliably.
        return jsonify({
            "error": "Missing lat/lng; required to determine nearest PADD region.",
            "example": "GET /api/gas-prices?zip=21163&lat=39.3081049&lng=-76.8896183",
        }), 400

    try:
        padd = map_lat_lng_to_padd(float(lat), float(lng))
        prices = fetch_eia_weekly_retail_gas_diesel_latest(padd)
    except requests.HTTPError as e:
        return jsonify({"error": "EIA request failed", "details": str(e)}), 502
    except Exception as e:
        return jsonify({"error": "Unexpected error", "details": str(e)}), 500

    # If EIA call succeeded but extraction failed, surface diagnostics as HTTP 200
    # so the frontend can display N/A and we can still see EIA's raw payload in console.
    return jsonify({"zip": m.group(1), "padd": padd, "prices": prices})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
