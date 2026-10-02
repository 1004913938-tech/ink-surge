import { useEffect, useState } from "react";

import { Audience } from "./Audience";
import { Host } from "./Host";

function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHashRoute();
  const join = hash.match(/^#\/j\/([A-Za-z0-9]+)/);
  if (join) return <Audience code={join[1].toUpperCase()} />;
  if (hash.startsWith("#/host") || hash === "" || hash === "#/") return <Host />;
  return <div className="page"><p>未知页面。<a href="#/host">主持人</a></p></div>;
}
