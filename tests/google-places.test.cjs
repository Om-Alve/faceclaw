const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
// Results are built inside the loader's vm context; copy them into this realm before deepEqual.
const plain = value => JSON.parse(JSON.stringify(value));

function load({ key = 'AIzaTestKey', response = { ok: true, status: 200, body: { places: [] } } } = {}) {
  const calls = [];
  const http = {
    fetchTextWithUserAgent: async (url, init) => {
      calls.push({ url, init });
      return { ok: response.ok, status: response.status,
        json: async () => { if (response.body === undefined) throw new SyntaxError('not json'); return response.body; } };
    },
  };
  const places = loader({}, {
    './settings-store': { getStringSetting: (_key, fallback) => key ?? fallback },
    '../util/http': http,
  })('app/native/google-places.ts');
  return { places, calls };
}

test('Text Search asks only for Pro-tier fields and biases toward the user', async () => {
  const { places, calls } = load({ key: '  AIzaTestKey  ' });
  await places.searchGooglePlaces('chai point', { latitude: 12.97, longitude: 77.59 }, 5);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://places.googleapis.com/v1/places:searchText');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-Goog-Api-Key'], 'AIzaTestKey');
  assert.equal(init.headers['X-Goog-FieldMask'],
    'places.displayName,places.shortFormattedAddress,places.formattedAddress,places.location');
  assert.deepEqual(JSON.parse(init.body), {
    textQuery: 'chai point', pageSize: 5, languageCode: 'en',
    locationBias: { circle: { center: { latitude: 12.97, longitude: 77.59 }, radius: 10000 } },
  });
});

test('no location fix means no location bias', async () => {
  const { places, calls } = load();
  await places.searchGooglePlaces('Kempegowda airport', null);
  assert.equal(JSON.parse(calls[0].init.body).locationBias, undefined);
});

test('responses map onto geocode candidates, skipping places without a location', async () => {
  const { places } = load({ response: { ok: true, status: 200, body: { places: [
    { displayName: { text: 'Chai Point' }, shortFormattedAddress: '80 Ft Rd, Indiranagar',
      formattedAddress: '80 Feet Rd, Indiranagar, Bengaluru, Karnataka 560038, India',
      location: { latitude: 12.9719, longitude: 77.6412 } },
    { displayName: { text: 'No location' } },
    { formattedAddress: 'Full address only', location: { latitude: 1, longitude: 2 } },
  ] } } });
  assert.deepEqual(plain(await places.searchGooglePlaces('chai', null)), [
    { name: 'Chai Point', placeFormatted: '80 Ft Rd, Indiranagar', longitude: 77.6412, latitude: 12.9719, distanceMeters: null },
    { name: '(unnamed)', placeFormatted: 'Full address only', longitude: 2, latitude: 1, distanceMeters: null },
  ]);
});

test('an empty response is no candidates, not an error', async () => {
  const { places } = load({ response: { ok: true, status: 200, body: {} } });
  assert.deepEqual(plain(await places.searchGooglePlaces('nowhere', null)), []);
});

test('HTTP errors carry Google\'s message', async () => {
  const { places } = load({ response: { ok: false, status: 403,
    body: { error: { code: 403, message: 'Places API (New) has not been used in project 123 before or it is disabled.' } } } });
  await assert.rejects(places.searchGooglePlaces('x', null), /HTTP 403: Places API \(New\) has not been used/);
});

test('a non-JSON error body still reports the status', async () => {
  const { places } = load({ response: { ok: false, status: 502, body: undefined } });
  await assert.rejects(places.searchGooglePlaces('x', null), /^Error: Google Places search failed \(HTTP 502\)\.$/);
});

test('without a key it refuses before making a request', async () => {
  const { places, calls } = load({ key: '' });
  assert.equal(places.isGooglePlacesConfigured(), false);
  await assert.rejects(places.searchGooglePlaces('x', null), /Set a Google Places key/);
  assert.equal(calls.length, 0);
});
