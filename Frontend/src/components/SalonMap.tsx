'use client';

import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect } from 'react';
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import type { SalonSummary } from '@/lib/api';
import type { LatLng } from '@/lib/hooks';

const pin = (selected: boolean) =>
  L.divIcon({
    className: '',
    iconSize: [34, 42],
    iconAnchor: [17, 40],
    html: `<svg viewBox="0 0 34 42" width="34" height="42"><path d="M17 41s15-13.5 15-24A15 15 0 0 0 2 17c0 10.5 15 24 15 24z" fill="${
      selected ? 'var(--accent)' : 'var(--brand)'
    }" stroke="white" stroke-width="2"/><circle cx="17" cy="17" r="5.5" fill="white"/></svg>`,
  });

const me = L.divIcon({
  className: '',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
  html: '<span style="display:block;width:18px;height:18px;border-radius:50%;background:#2f6fed;border:3px solid white;box-shadow:0 0 0 6px rgba(47,111,237,.2)"></span>',
});

function Fit({ points }: { points: [number, number][] }) {
  const map = useMap();
  const key = JSON.stringify(points);
  useEffect(() => {
    if (points.length === 1) map.setView(points[0]!, 15);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 15 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

export default function SalonMap({
  salons,
  selected,
  onSelect,
  userLocation,
}: {
  salons: SalonSummary[];
  selected: string | null;
  onSelect: (slug: string) => void;
  userLocation: LatLng | null;
}) {
  const points: [number, number][] = salons.map((s) => [s.lat, s.lng]);
  if (userLocation) points.push([userLocation.lat, userLocation.lng]);
  const center: [number, number] = points[0] ?? [19.076, 72.8777];
  return (
    <MapContainer center={center} zoom={14} scrollWheelZoom={false} className="h-full w-full" attributionControl>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {salons.map((s) => (
        <Marker
          key={s.id}
          position={[s.lat, s.lng]}
          icon={pin(s.slug === selected)}
          title={s.name}
          eventHandlers={{ click: () => onSelect(s.slug) }}
        />
      ))}
      {userLocation && <Marker position={[userLocation.lat, userLocation.lng]} icon={me} title="You" />}
      <Fit points={points} />
    </MapContainer>
  );
}
