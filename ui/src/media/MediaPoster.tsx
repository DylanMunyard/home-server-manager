// Poster artwork for the detail views. `src` is the arr image remoteUrl (a
// public TMDB/thetvdb CDN link). Renders nothing without a URL, and hides
// itself if the image 404s/blocks so a broken-image glyph never shows.
export function Poster({ src, alt }: { src?: string; alt: string }) {
  if (!src) return null;
  return (
    <img
      className="media-poster"
      src={src}
      alt={alt}
      loading="lazy"
      onError={(e) => { e.currentTarget.style.display = 'none'; }}
    />
  );
}
