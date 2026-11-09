import "./webBridge.js";
import "@fontsource-variable/geist";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { applyPlatformClass } from "./platform.js";

applyPlatformClass();

createRoot(document.getElementById("root")).render(<App />);
