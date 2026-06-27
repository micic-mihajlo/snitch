import React from "react";
import ReactDOM from "react-dom/client";
import { Deck } from "./Deck";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Deck />
  </React.StrictMode>
);
