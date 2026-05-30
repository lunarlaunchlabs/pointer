import { createRoot } from "preact/compat/client";
import App from "@/App";
import "@/index.css";

createRoot(document.getElementById("root")!).render(<App />);
