// P0: Server component layout — injects a preload hint for the default /api/jobs/init
// query into the HTML <head> so the browser starts fetching job data the moment
// HTML is parsed, ~264ms before React even mounts.
// Covers the ~80% of visitors who land with default params.

// Must exactly match the URLSearchParams order that JobsClient generates so the
// browser's preload cache is a hit when SSR fails and the client falls back to
// fetching /api/jobs/init on its own. Previously missing `company=` caused a
// URL mismatch → the preload was wasted every time.
const PRELOAD_URL =
  "/api/jobs/init?q=&location=all&company=&posted=7d&sort=recent&page=0&signal=all&visa=H1B&department=all&level=all";

export default function JobsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="preload" as="fetch" href={PRELOAD_URL} crossOrigin="anonymous" />
      {children}
    </>
  );
}
