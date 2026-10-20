// Gate photos. In the demo they live inside the record as small JPEG / SVG data URLs; in production the same field holds
// an object-storage reference (S3 / Azure) and the file is served by the backend.
const HUES = [212, 160, 28, 280, 340, 190, 100, 12];
const initialsOf = (name = '?') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';

/** A stand-in portrait for seed data and the simulator (a coloured disc with the person's initials). */
export function avatar(name, seed = 0) {
  const h = HUES[(seed + (name || '').length) % HUES.length];
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'><rect width='120' height='120' fill='hsl(${h} 45% 90%)'/><circle cx='60' cy='46' r='22' fill='hsl(${h} 35% 62%)'/><path d='M16 120c4-30 26-42 44-42s40 12 44 42z' fill='hsl(${h} 35% 62%)'/><text x='60' y='108' text-anchor='middle' font-family='sans-serif' font-size='16' font-weight='700' fill='hsl(${h} 45% 25%)'>${initialsOf(name)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Read a camera / gallery image, scale it down (default 360 px wide) and return a JPEG data URL. */
export function fileToPhoto(file, max = 360, quality = 0.72) {
  return new Promise((resolve, reject) => {
    if (!file) { resolve(''); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the photo'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a picture'));
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
