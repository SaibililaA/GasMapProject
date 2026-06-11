// Uses Google Maps JS API + Advanced Markers + Places (New) + Routes Library

let map;
let infowindow;
let markers = [];
let activeDirectionsRenderer = null;

function getMapEl() {
    const el = document.getElementById('map');
    if (!el) throw new Error('Could not find #map element.');
    return el;
}

function waitForGoogleMaps(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            if (window.google && google.maps && google.maps.Map) return resolve();
            if (Date.now() - start > timeoutMs) return reject(new Error('Google Maps JS API did not load.'));
            setTimeout(check, 100);
        };
        check();
    });
}

function openSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.add('open');
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('open');
}

function computeDistanceMiles(aLatLng, bLatLng) {
    if (!aLatLng || !bLatLng) return null;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 3958.7613;
    const lat1 = typeof aLatLng.lat === 'function' ? aLatLng.lat() : aLatLng.lat;
    const lon1 = typeof aLatLng.lng === 'function' ? aLatLng.lng() : aLatLng.lng;
    const lat2 = typeof bLatLng.lat === 'function' ? bLatLng.lat() : bLatLng.lat;
    const lon2 = typeof bLatLng.lng === 'function' ? bLatLng.lng() : bLatLng.lng;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const h = sinDLat * sinDLat + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinDLon * sinDLon;
    const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return (R * c).toFixed(2);
}

function getTravelModeLabel(travelMode) {
    const labels = {
        DRIVE: 'By car',
        BICYCLE: 'By bike',
        WALK: 'On foot',
        TRANSIT: 'By bus',
        TWO_WHEELER: 'By scooter',
    };
    return labels[travelMode] || travelMode;
}

function formatModeRowHtml(modeKey, label) {
    return `
        <div class="travel-row" data-mode="${modeKey}">
            <div class="travel-label">${label}</div>
            <div class="travel-distance">Distance: <span class="travel-distance-value">…</span></div>
            <div class="travel-duration">Time: <span class="travel-duration-value">…</span></div>
        </div>
    `;
}

// -------------------------------------------------------------------
// Directions – uses DirectionsService.
// (Kept as the stable approach for consistent distance/duration extraction.)

// -------------------------------------------------------------------
let _directionsService = null;
function getDirectionsService() {
    if (!_directionsService) _directionsService = new google.maps.DirectionsService();
    return _directionsService;
}

// Map the new-style travel mode keys ('DRIVE', 'WALK', etc.) used in the
// sidebar back to the legacy TravelMode enum values DirectionsService needs.
const TRAVEL_MODE_MAP = {
    DRIVE:   'DRIVING',
    WALK:    'WALKING',
    BICYCLE: 'BICYCLING',
    TRANSIT: 'TRANSIT',
};

function getDirectionsSummaryNew(origin, destination, travelModeKey) {
    const legacyMode = TRAVEL_MODE_MAP[travelModeKey] || travelModeKey;

    const toLoc = (p) => typeof p.lat === 'function' ? p : { lat: p.lat, lng: p.lng };

    return new Promise((resolve) => {
        try {
            getDirectionsService().route(
                { origin: toLoc(origin), destination: toLoc(destination), travelMode: legacyMode },
                (result, status) => {
                    if (status !== 'OK' || !result) { resolve(null); return; }
                    const leg = result?.routes?.[0]?.legs?.[0];
                    resolve(leg ? { distanceText: leg.distance?.text, durationText: leg.duration?.text } : null);
                }
            );
        } catch (err) {
            console.warn(`Directions failed for mode ${travelModeKey}:`, err?.message || err);
            resolve(null);
        }
    });
}

async function initApp() {
    await waitForGoogleMaps();

    const mapEl = getMapEl();
    const defaultCenter = { lat: 39.8283, lng: -98.5795 };
    const mapId = '499815d5bc6e92476a117e0b'; // Required for AdvancedMarkerElement

    map = new google.maps.Map(mapEl, {
        center: defaultCenter,
        zoom: 14,
        mapId,
    });

    infowindow = new google.maps.InfoWindow();

    // Don't run a gas search with the default center; it can re-center the map after geolocation.
    // We'll run nearbyGasSearch again once user location is known.

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            async (position) => {

                const userLocation = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude,
                };
                window.__userLocation = userLocation;

                map.setCenter(userLocation);

                await createMarkerAt(
                    userLocation,
                    map,
                    'You are here',
                    'http://maps.google.com/mapfiles/ms/icons/blue-dot.png'
                );

                // Initial load
                nearbyGasSearch(userLocation);

                // Zoom-based expansion: zoom out => larger radius + more results.
                // Pins outside the visible map will disappear only after the new search completes.
                let zoomDebounceTimer = null;
                const onZoomChanged = () => {
                    try {
                        if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer);
                        zoomDebounceTimer = setTimeout(() => {
                            nearbyGasSearch(userLocation);
                        }, 400);
                    } catch (_) {}
                };

                map.addListener('zoom_changed', onZoomChanged);

            },
            (error) => {
                console.error('Geolocation error:', error);
                let msg = 'Error: Geolocation service failed.';
                if (error?.code === error?.PERMISSION_DENIED) msg = 'Error: Location permission denied.';
                else if (error?.code === error?.POSITION_UNAVAILABLE) msg = 'Error: Location unavailable.';
                else if (error?.code === error?.TIMEOUT) msg = 'Error: Location timed out.';

                window.__userLocation = defaultCenter;
                handleLocationError(true, infowindow, defaultCenter, msg);
            }
        );
    } else {
        window.__userLocation = defaultCenter;
        handleLocationError(false, infowindow, defaultCenter);
    }
}

// -------------------------------------------------------------------
// Markers – uses AdvancedMarkerElement (no deprecation warning)
// -------------------------------------------------------------------
async function createMarkerAt(position, mapInstance, title, iconUrl) {
    const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');

    const img = document.createElement('img');
    img.src = iconUrl;
    img.alt = title || '';
    img.style.cssText = 'width:32px;height:32px;';

    const content = document.createElement('div');
    content.className = 'advanced-marker-content';
    content.appendChild(img);

    return new AdvancedMarkerElement({ position, map: mapInstance, title: title || '', content });
}

function clearGasStationMarkers() {
    for (const marker of markers) {
        try { if (marker) marker.map = null; } catch (_) {}
    }
    markers = [];
}

// -------------------------------------------------------------------
// Nearby Search – uses Place.searchNearby (new API, no deprecation)
// -------------------------------------------------------------------
function getLatLngFromPlaceLocation(loc) {
    if (!loc) return null;
    return {
        lat: (typeof loc.lat === 'function') ? loc.lat() : loc.lat,
        lng: (typeof loc.lng === 'function') ? loc.lng() : loc.lng,
    };
}

function isValidLatLng(obj) {
    return obj && typeof obj.lat === 'number' && typeof obj.lng === 'number' && !Number.isNaN(obj.lat) && !Number.isNaN(obj.lng);
}

function getSearchConfigForZoom(zoom) {
    // Goal: zooming out => larger radius + more results.
    // These are empirical defaults; can be tuned later.
    const z = typeof zoom === 'number' ? zoom : 14;

    // radius grows as zoom decreases.
    // zoom 14 ~ 8km, zoom 12 ~ 15km, zoom 10 ~ 30km, zoom 8 ~ 60km
    let radiusMeters;
    if (z >= 14) radiusMeters = 8000;
    else if (z >= 12) radiusMeters = 15000;
    else if (z >= 10) radiusMeters = 30000;
    else if (z >= 8) radiusMeters = 60000;
    else radiusMeters = 90000;

    // Cap results to keep the UI responsive.
    // Requirement: return up to 20 locations.
    const maxResultCount = 20;

    return { radiusMeters, maxResultCount };
}

let _lastGasSearchKey = null;
async function nearbyGasSearch(userLocation, { radiusMeters, maxResultCount } = {}) {
    const { radiusMeters: defRadius, maxResultCount: defMax } = getSearchConfigForZoom(map?.getZoom?.() ?? 14);
    const effectiveRadius = radiusMeters ?? defRadius;
    const effectiveMax = maxResultCount ?? defMax;

    // Cache by radius+max so we avoid redundant API calls while zoom is changing.
    const searchKey = `${effectiveRadius}:${effectiveMax}`;
    if (_lastGasSearchKey === searchKey) return;
    _lastGasSearchKey = searchKey;

    // Do not clear existing pins until we have confirmed new results.
    try {
        const { Place } = await google.maps.importLibrary('places');

        const center = new google.maps.LatLng(
            typeof userLocation.lat === 'function' ? userLocation.lat() : userLocation.lat,
            typeof userLocation.lng === 'function' ? userLocation.lng() : userLocation.lng
        );

        const request = {
            fields: [
                'displayName', 'location', 'businessStatus',
                'formattedAddress', 'rating', 'userRatingCount',
                'photos', 'regularOpeningHours', 'internationalPhoneNumber',
                'websiteURI', 'addressComponents',
            ],
            locationRestriction: {
                center,
                radius: effectiveRadius,
            },
            includedPrimaryTypes: ['gas_station'],
            maxResultCount: effectiveMax,
        };

        const { places } = await Place.searchNearby(request);


        if (!places || places.length === 0) {
            console.warn('Place.searchNearby returned no gas stations.');
            return;
        }

        console.log('Place.searchNearby results:', places.length);

        // 1) Draw all markers
        for (const place of places) {
            await createGasMarker(place);
        }

        // 2) Determine closest by straight-line distance from the provided user location
        const userLatLng = {
            lat: typeof userLocation.lat === 'function' ? userLocation.lat() : userLocation.lat,
            lng: typeof userLocation.lng === 'function' ? userLocation.lng() : userLocation.lng,
        };

        if (!isValidLatLng(userLatLng)) return;

        let closest = null;
        let closestDist = Infinity;

        for (const place of places) {
            const stationLatLng = getLatLngFromPlaceLocation(place.location);
            if (!isValidLatLng(stationLatLng)) continue;

            const dist = Number(computeDistanceMiles(userLatLng, stationLatLng));
            if (!Number.isFinite(dist)) continue;

            if (dist < closestDist) {
                closestDist = dist;
                closest = place;
            }
        }

        if (!closest) return;
        window.__closestGasStation = closest;

        // 3) Auto-open the sidebar for the closest station
        // Find the marker instance for the closest place (by coordinate match)
        const stationLatLng = getLatLngFromPlaceLocation(closest.location);
        const marker = markers.find(m => {
            const p = m?.position;
            if (!p) return false;
            const mLat = (typeof p.lat === 'function') ? p.lat() : p.lat;
            const mLng = (typeof p.lng === 'function') ? p.lng() : p.lng;
            return mLat === stationLatLng.lat && mLng === stationLatLng.lng;
        });

        // If we have a real user location, keep map centered on it.
        // (Prevents the initial defaultCenter from re-centering after closest logic runs.)
        if (isValidLatLng(userLatLng)) {
            try {
                map.setCenter(userLatLng);
            } catch (_) {}
        }

        // If not found, pass undefined marker (handleGasMarkerClick uses marker for InfoWindow anchor)
        // We'll still render sidebar content.
        await handleGasMarkerClick(closest, marker);
    } catch (err) {
        console.error('Place.searchNearby failed:', err);
    }
}

// -------------------------------------------------------------------
// Gas station marker + sidebar
// -------------------------------------------------------------------
async function createGasMarker(place) {
    const loc = place.location;
    if (!loc) return;

    const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');

    const img = document.createElement('img');
    img.src = 'http://maps.google.com/mapfiles/ms/icons/red-dot.png';
    img.alt = place.displayName || 'Gas station';
    img.style.cssText = 'width:32px;height:32px;';

    const content = document.createElement('div');
    content.className = 'advanced-marker-content';
    content.appendChild(img);

    const marker = new AdvancedMarkerElement({
        position: loc,
        map,
        title: place.displayName || '',
        content,
    });

    // Preferred: Maps click event for AdvancedMarkerElement
    marker.addEventListener('gmp-click', () => handleGasMarkerClick(place, marker));

    // Fallback: some environments may not dispatch gmp-click reliably.
    // Make the DOM content clickable so users can still open the sidebar.
    content.style.cursor = 'pointer';
    content.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleGasMarkerClick(place, marker);
    });

    markers.push(marker);
}

async function handleGasMarkerClick(place, marker) {
    const name = place.displayName || '';
    const address = place.formattedAddress || '';
    const rating = typeof place.rating === 'number' ? `Rating: ${place.rating} / 5` : 'Rating: N/A';
    const reviewCount = typeof place.userRatingCount === 'number'
        ? `${place.userRatingCount.toLocaleString()} review(s)` : '';

    // Photo: new API uses fetchFields / photos array with getURI()
    let photoHtml = '';
    try {
        if (place.photos && place.photos.length > 0) {
            const photoUri = place.photos[0].getURI({ maxWidth: 500, maxHeight: 260 });
            photoHtml = `<img src="${photoUri}" alt="${name}" style="width:100%;height:auto;border-radius:10px;display:block;margin-bottom:10px;" />`;
        }
    } catch (_) {}

const origin = window.__userLocation;
    const destination = place.location;


    // Use the station's coordinates to call CollectAPI “fromCoordinates”.
    const stationLat = (typeof place.location?.lat === 'function') ? place.location.lat() : place.location?.lat;
    const stationLng = (typeof place.location?.lng === 'function') ? place.location.lng() : place.location?.lng;

const travelModes = [
        { key: 'DRIVE', label: 'By car', googleTravelMode: 'driving' },
        { key: 'BICYCLE', label: 'By bike', googleTravelMode: 'bicycling' },
        { key: 'WALK', label: 'On foot', googleTravelMode: 'walking' },
        { key: 'TRANSIT', label: 'By bus', googleTravelMode: 'transit' },
    ];

    const travelSummaryHtml = `
        <div class="travel-summary">
            <div class="travel-summary-title">Travel summary</div>
            <div class="travel-summary-subtitle">From your location</div>
            <div class="travel-rows">
                ${travelModes.map(m => formatModeRowHtml(m.key, m.label)).join('')}
            </div>
            <div class="travel-summary-footnote">Times/distances estimated by Google Routes.</div>
        </div>
    `;

    // Extract ZIP from addressComponents (new Place API)
    let zip = null;
    try {
        const zipComp = place.addressComponents?.find(c => c.types?.includes('postal_code'));
        zip = zipComp?.shortText || zipComp?.longText || null;
    } catch (_) {}
    if (!zip && address) {
        const m = address.match(/\b(\d{5})(?:-\d{4})?\b/);
        if (m) zip = m[1];
    }

    // Opening hours
    let hoursHtml = '';
    try {
        const wt = place.regularOpeningHours?.weekdayDescriptions;
        if (wt && wt.length) hoursHtml = `<div><b>Hours:</b> ${wt.join('<br/>')}</div>`;
    } catch (_) {}

const googleDirectionsLinkHtml = (() => {
        const originLat = origin?.lat;
        const originLng = origin?.lng;
        const dest = destination;
        const destLat = dest?.lat;
        const destLng = dest?.lng;

        // destination/place.location in this file is a LatLng-ish object. Normalize to numbers.
        const oLat = (typeof originLat === 'function') ? originLat() : originLat;
        const oLng = (typeof originLng === 'function') ? originLng() : originLng;
        const dLat = (typeof destLat === 'function') ? destLat() : destLat;
        const dLng = (typeof destLng === 'function') ? destLng() : destLng;

        if (oLat == null || oLng == null || dLat == null || dLng == null) return '';

        const buildLink = (travelMode) => {
            const tm = encodeURIComponent(travelMode);
            return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(oLat + ',' + oLng)}&destination=${encodeURIComponent(dLat + ',' + dLng)}&travelmode=${tm}`;
        };

        // Show links for the modes you already compute in the sidebar.
        const drive = travelModes.find(m => m.key === 'DRIVE');
        const links = travelModes
            .filter(m => m.googleTravelMode)
            .map(m => {
                const href = buildLink(m.googleTravelMode);
                return `<a href="${href}" target="_blank" rel="noreferrer" style="margin-right:10px;display:inline-block;margin-top:6px;">${m.label}</a>`;
            })
            .join('');

        // Prefer to display all travel-mode links.
        return `
            <div class="travel-google-links" style="margin-top:10px;">
                <div style="font-weight:800;font-size:13px;margin-bottom:4px;">Open in Google Maps</div>
                <div style="font-size:12.5px;color:#333;line-height:1.4;">Route directions to this station.</div>
                <div>${links || (drive ? `<a href="${buildLink(drive.googleTravelMode)}" target="_blank" rel="noreferrer">${drive.label}</a>` : '')}</div>
            </div>
        `;
    })();

    const contentString = `
        ${photoHtml}
        <h3 style="margin:0 0 6px 0;font-size:16px;">${name}</h3>
        <div style="color:#555;margin-bottom:8px;">${address}</div>
        <div style="margin:6px 0;">${rating}</div>
        ${reviewCount ? `<div style="color:#666;margin-bottom:8px;">${reviewCount}</div>` : ''}

        ${travelSummaryHtml}
        ${googleDirectionsLinkHtml}

        <div class="gas-prices" style="margin-top:12px;">
            <div class="gas-prices-title">Gas prices</div>
            <div class="gas-prices-subtitle">Based on ZIP (from station details)</div>
            <div class="gas-prices-grid">
                <div class="gas-price-row"><span class="gas-price-name">Regular</span><span class="gas-price-value" data-fuel="regular">…</span></div>
                <div class="gas-price-row"><span class="gas-price-name">Midgrade</span><span class="gas-price-value" data-fuel="midgrade">…</span></div>
                <div class="gas-price-row"><span class="gas-price-name">Premium</span><span class="gas-price-value" data-fuel="premium">…</span></div>
                <div class="gas-price-row"><span class="gas-price-name">Diesel</span><span class="gas-price-value" data-fuel="diesel">…</span></div>
            </div>
            <div class="gas-prices-status" id="gas-prices-status">Loading…</div>
        </div>

        <div style="font-size:13px;color:#333;line-height:1.4;margin-top:10px;">
            ${address ? `<div><b>Address:</b> ${address}</div>` : ''}
            ${hoursHtml}
            ${place.internationalPhoneNumber ? `<div><b>Phone:</b> ${place.internationalPhoneNumber}</div>` : ''}
            ${place.websiteURI ? `<div><b>Website:</b> <a href="${place.websiteURI}" target="_blank" rel="noreferrer">${place.websiteURI}</a></div>` : ''}
        </div>
    `;

    openSidebar();
    const sidebarContent = document.getElementById('sidebar-content');
    if (sidebarContent) sidebarContent.innerHTML = contentString;

    // Gas prices from local proxy
    const gasStatusEl = document.getElementById('gas-prices-status');

    const setFuelValue = (fuelKey, val) => {
        const el = document.querySelector(`.gas-price-value[data-fuel="${fuelKey}"]`);
        if (el) el.textContent = val;
    };
    const setAllUnavailable = (msg) => {
        ['regular', 'midgrade', 'premium', 'diesel'].forEach(k => setFuelValue(k, 'N/A'));
        if (gasStatusEl) gasStatusEl.textContent = msg;
    };

    // CollectAPI “fromCoordinates” endpoint requires coordinates.
    // Use the station's coordinates (place.location) rather than ZIP.
    const lat = stationLat;
    const lng = stationLng;
    
    if (lat == null || lng == null) {
        setAllUnavailable('Station coordinates not available.');
    } else {
        if (gasStatusEl) gasStatusEl.textContent = `Loading gas prices…`;
        const url = `${(window.RENDER_BACKEND_BASE_URL || 'http://74.220.49.0/24')}/api/gas-prices?zip=${encodeURIComponent(zip || '')}&lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`;

        fetch(url)
            .then(async r => {
                const text = await r.text();
                let data;
                try { data = text ? JSON.parse(text) : null; } catch (_) { data = { error: 'Invalid JSON' }; }
                if (!r.ok) { setAllUnavailable(`Gas prices unavailable (server ${r.status}).`); return null; }
                return data;
            })
            .then(data => {
                if (!data) return;
                if (data?.error || !data?.prices) { setAllUnavailable('Gas prices unavailable.'); return; }
                const prices = data.prices;
                const fmt = k => {
                    const t = prices?.[k];
                    const v = t?.todayLow ?? t?.today;
                    return (typeof v === 'number' || typeof v === 'string') ? `$${v}` : 'N/A';
                };
                ['regular', 'midgrade', 'premium', 'diesel'].forEach(k => setFuelValue(k, fmt(k)));
                const hasAny = ['regular', 'midgrade', 'premium', 'diesel'].some(k => prices?.[k]?.todayLow != null || prices?.[k]?.today != null);
                if (gasStatusEl) gasStatusEl.textContent = hasAny
                    ? `From EIA (PADD ${data.padd}). Latest week.`
                    : `EIA returned no prices.`;
            })
            .catch(err => {
                console.error('Gas prices fetch failed:', err);
                setAllUnavailable('Gas prices unavailable (network error).');
            });
    }

    // Compute directions with new Routes library
    if (origin && destination) {
        const setModeValues = (key, summary) => {
            const row = document.querySelector(`.travel-row[data-mode="${key}"]`);
            if (!row) return;
            row.querySelector('.travel-distance-value').textContent = summary?.distanceText || 'N/A';
            row.querySelector('.travel-duration-value').textContent = summary?.durationText || 'N/A';
        };

        await Promise.all(
            travelModes.map(async m => {
                try {
                    const summary = await getDirectionsSummaryNew(origin, destination, m.key);
                    setModeValues(m.key, summary);
                } catch (_) {
                    setModeValues(m.key, null);
                }
            })
        );
    }

    // Draw an actual route polyline on the map (driving mode by default)
    // so users can see the route to whichever station they click.
    try {
        if (origin && destination) {
            const originLoc = (typeof origin?.lat === 'function')
                ? { lat: origin.lat(), lng: origin.lng() }
                : { lat: origin.lat, lng: origin.lng };
            const destLoc = (typeof destination?.lat === 'function')
                ? { lat: destination.lat(), lng: destination.lng() }
                : { lat: destination.lat, lng: destination.lng };

            const travelMode = 'DRIVING';

            // Clear previous route from the map
            if (activeDirectionsRenderer) {
                try { activeDirectionsRenderer.setMap(null); } catch (_) {}
                activeDirectionsRenderer = null;
            }

            const renderer = new google.maps.DirectionsRenderer({
                suppressMarkers: true,
                preserveViewport: true,
            });

            activeDirectionsRenderer = renderer;
            renderer.setMap(map);

            const directionsService = getDirectionsService();
            directionsService.route(
                { origin: originLoc, destination: destLoc, travelMode },
                (result, status) => {
                    if (status === 'OK' && result) renderer.setDirections(result);
                }
            );
        }
    } catch (e) {
        console.warn('Failed to render directions on map:', e);
    }

    infowindow.setContent(`<strong>${name}</strong><br>${address}`);
    infowindow.open({ map, anchor: marker });
}

function formatPlaceAddress(place) {
    // Kept for backwards compat; new Place API provides formattedAddress directly.
    return place?.formattedAddress || place?.vicinity || '';
}

function handleLocationError(browserHasGeolocation, infoWindow, pos, extraMessage) {
    infoWindow.setPosition(pos);
    infoWindow.setContent(
        browserHasGeolocation
            ? extraMessage || 'Error: The Geolocation service failed.'
            : "Error: Your browser doesn't support geolocation."
    );
    infoWindow.open(map);
}

async function checkBackendHealth() {
    const statusEl = document.getElementById('backend-status');
    if (!statusEl) return;

    statusEl.textContent = 'Backend: connecting…';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    try {
        const res = await fetch((window.RENDER_BACKEND_BASE_URL || 'http://74.220.49.0/24') + '/api/health', {

            method: 'GET',
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        statusEl.textContent = 'Backend: connected';
    } catch (err) {
        statusEl.textContent = `Backend: not running (expected ${(window.RENDER_BACKEND_BASE_URL || 'http://127.0.0.1:5000')}/api/health)`;
        console.warn('Health check failed:', err?.message || err);
    } finally {
        clearTimeout(timeoutId);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const closeBtn = document.getElementById('sidebar-close');
    if (closeBtn) closeBtn.addEventListener('click', closeSidebar);

    // Automatically call backend on load (warm/health check).
    checkBackendHealth().finally(() => {
        initApp().catch(e => console.error(e));
    });
});
