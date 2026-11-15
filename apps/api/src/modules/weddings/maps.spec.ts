import { parseMapsLink } from './maps';

describe('parseMapsLink', () => {
  it.each([
    ['https://www.google.com/maps/place/Taj+Lake+Palace/@24.5754,73.6800,17z', { lat: 24.5754, lng: 73.68 }],
    ['https://www.google.com/maps/search/?api=1&query=24.5754,73.68&query_place_id=ChIJabc', { lat: 24.5754, lng: 73.68, placeId: 'ChIJabc' }],
    ['https://maps.google.com/?q=12.9716,77.5946', { lat: 12.9716, lng: 77.5946 }],
    ['https://www.google.com/maps/place/X/data=!3d24.57!4d73.68', { lat: 24.57, lng: 73.68 }],
    ['https://maps.apple.com/?ll=19.076,72.8777&q=Venue', { lat: 19.076, lng: 72.8777 }],
  ])('%s', (link, expected) => {
    expect(parseMapsLink(link)).toEqual(expected);
  });

  it('refuses other hosts and junk', () => {
    expect(parseMapsLink('https://evil.example/maps?q=1,2')).toBe('host_not_allowed');
    expect(parseMapsLink('not a link')).toBeNull();
    expect(parseMapsLink('https://maps.google.com/?q=Taj+Palace')).toBeNull();
  });
});
