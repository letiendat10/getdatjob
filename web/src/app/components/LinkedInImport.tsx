"use client";

import { useState } from "react";

type Preview = {
  full_name: string | null;
  headline: string | null;
  location: string | null;
  positions_count: number;
};

export default function LinkedInImport({
  initialUrl = "",
  onImported,
  className,
}: {
  initialUrl?: string;
  onImported?: (preview: Preview) => void;
  className?: string;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setPreview(null);

    try {
      const res = await fetch("/api/import-linkedin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkedin_url: url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Import failed.");
        return;
      }
      setPreview(data.profile);
      onImported?.(data.profile);
    } catch {
      setError("Network error — try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={className}>
      <form onSubmit={handleImport} className="space-y-2">
        <label htmlFor="linkedin-url" className="block text-sm font-medium">
          Your LinkedIn URL
        </label>
        <input
          id="linkedin-url"
          type="url"
          required
          placeholder="https://www.linkedin.com/in/your-handle"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={loading}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={loading || !url}
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Importing…" : "Import from LinkedIn"}
        </button>
      </form>

      {error && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      {preview && (
        <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm">
          <p className="font-medium">Imported.</p>
          {preview.full_name && <p>Name: {preview.full_name}</p>}
          {preview.headline && <p>Headline: {preview.headline}</p>}
          {preview.location && <p>Location: {preview.location}</p>}
          <p>Positions: {preview.positions_count}</p>
        </div>
      )}
    </div>
  );
}
