if (new URLSearchParams(location.search).has("capture")) window.addEventListener("error", (e) => console.log("[bs] ERR " + (e.error?.stack || e.message)));
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./ui/styles.css";
import { loadFonts } from "./assets";

const params = new URLSearchParams(location.search);
const root = createRoot(document.getElementById("root")!);
// The game (App) loads its fonts only after the player clicks Play; the dev views load them straight away.
if (params.get("lab") === "character") {
  loadFonts();
  import("./lab").then(({ Lab }) => root.render(<Lab />));
} else if (params.has("lookdev")) {
  loadFonts();
  import("./lookdev").then(({ Lookdev }) => root.render(<Lookdev />));
} else {
  root.render(<Start />);
}

// Start screen. Nothing goes online until Play: the game code (App), Rapier, fonts, models, sounds
// and the game server connection all load after the click.
function Start() {
  const [loading, setLoading] = useState(false);
  const play = () => {
    if (loading) return;
    setLoading(true);
    import("./App").then(({ App }) => root.render(<App />));
  };
  return (
    <div className="app">
      <div className="start">
        <h1>Blastside</h1>
        <p>Playing connects to the Noteblock game server at play.noteblock.ai.</p>
        <button type="button" onClick={play} disabled={loading}>{loading ? "Loading" : "Play"}</button>
      </div>
    </div>
  );
}
