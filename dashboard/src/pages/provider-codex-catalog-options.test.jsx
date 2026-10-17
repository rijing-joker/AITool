import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexCatalogOptions } from "./provider-codex-catalog-options";

vi.mock("../lib/copy", () => ({ copy: key => key }));
afterEach(cleanup);

it("selects only current catalog models and explains a removed review model", () => {
  const onChange = vi.fn();
  const meta = { codexCatalogModels: [{ model: "main" }, { model: "reviewer" }] };
  const { rerender } = render(<CodexCatalogOptions meta={meta} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText("pswitch.catalog.auto_review"), { target: { value: "reviewer" } });
  expect(onChange).toHaveBeenCalledWith("codexAutoReviewModel", "reviewer");
  fireEvent.click(screen.getByLabelText("pswitch.catalog.speed_tiers"));
  expect(onChange).toHaveBeenCalledWith("codexSpeedTiersEnabled", false);
  rerender(<CodexCatalogOptions meta={{ ...meta, codexAutoReviewModel: "removed" }} onChange={onChange} />);
  expect(screen.getByText("pswitch.catalog.auto_review_missing")).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "removed" })).toBeDisabled();
});
