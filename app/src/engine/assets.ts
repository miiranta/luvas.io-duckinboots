/** Async asset loading helpers. All paths are relative to the app root. */

export function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
        img.src = url;
    });
}

export async function loadJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    return (await res.json()) as T;
}

/**
 * Load many images keyed by path, resolving to a map of the ones that
 * succeeded. Missing textures are logged and skipped rather than failing the
 * whole load, mirroring how the original game tolerated absent sprites.
 */
export async function loadImageMap(urls: Iterable<string>): Promise<Map<string, HTMLImageElement>> {
    const unique = [...new Set(urls)];
    const entries = await Promise.all(
        unique.map(async (url): Promise<[string, HTMLImageElement] | null> => {
            try {
                return [url, await loadImage(url)];
            } catch (e) {
                console.warn(e);
                return null;
            }
        }),
    );
    return new Map(entries.filter((e): e is [string, HTMLImageElement] => e !== null));
}
