import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./app.js";
import { initTheme } from "./theme.js";
initTheme();
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
