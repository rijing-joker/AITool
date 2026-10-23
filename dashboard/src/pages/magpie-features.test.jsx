import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopClients } from "./desktop-clients";
import { IntegrationsPanel } from "./integrations-panel";
import { RoutingPanel } from "./routing-panel";
import { ProxyToolsPanel } from "./proxy-tools-panel";
import { LibraryDistributionPanel } from "./library-distribution-panel";
import { proxyApi, integrationsApi, routingApi, toolsApi } from "../lib/proxy-api";
import { distributionApi } from "../lib/provider-switch-api";
vi.mock("../lib/copy",()=>({copy:key=>key}));
vi.mock("../lib/proxy-api",()=>({
  proxyApi:{desktopClientStatus:vi.fn(),desktopClientModels:vi.fn(),connectDesktopClient:vi.fn(),restoreDesktopClient:vi.fn()},
  integrationsApi:{status:vi.fn(),action:vi.fn()},routingApi:{status:vi.fn(),configure:vi.fn(),magpieEvents:vi.fn()},toolsApi:{status:vi.fn(),configure:vi.fn(),mount:vi.fn()}
}));
vi.mock("../lib/provider-switch-api",()=>({distributionApi:{list:vi.fn(),preview:vi.fn(),apply:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
beforeEach(()=>{proxyApi.desktopClientStatus.mockResolvedValue({clients:[]});proxyApi.desktopClientModels.mockResolvedValue({models:["one","two"]});});
it("desktop connection sends only selected models and the chosen Zed default",async()=>{
  proxyApi.connectDesktopClient.mockResolvedValue({});render(<DesktopClients keys={["key"]} remarks={{key:"Local"}} />);
  fireEvent.change(screen.getByLabelText("proxy.desktop.client"),{target:{value:"zed"}});
  fireEvent.click(screen.getByRole("button",{name:"proxy.desktop.models"}));await screen.findByText("one");
  fireEvent.click(screen.getByLabelText("one"));fireEvent.click(screen.getByLabelText("two"));
  fireEvent.change(screen.getByLabelText("proxy.desktop.default_model"),{target:{value:"two"}});
  fireEvent.click(screen.getByRole("button",{name:"proxy.desktop.connect"}));
  await waitFor(()=>expect(proxyApi.connectDesktopClient).toHaveBeenCalledWith("zed","key",["one","two"],"two"));
});
it("Magpie discovery remains explicit and enabling uses the reviewed revision",async()=>{
  integrationsApi.status.mockResolvedValue({magpie:{enabled:false,models:[]}});
  integrationsApi.action.mockResolvedValue({result:{revision:"r1",models:[{id:"group/daily"}]}});
  render(<IntegrationsPanel />);await screen.findByText("proxy.integration.disabled");expect(integrationsApi.action).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"proxy.integration.discover"}));await screen.findByText("group/daily");fireEvent.click(screen.getByLabelText("group/daily"));
  fireEvent.click(screen.getByRole("button",{name:"proxy.integration.enable"}));
  await waitFor(()=>expect(integrationsApi.action).toHaveBeenCalledWith("magpie","configure",{enabled:true,models:["group/daily"],revision:"r1"}));
});
it("routing keeps saved classifier visible without discovery and does not classify while viewing",async()=>{
  const value={mode:"rules",models:["one"],rules:[],intent:true,classifier:"small",quota:false,events:[]};
  routingApi.status.mockResolvedValue(value);routingApi.configure.mockResolvedValue({...value,enabled:true});
  render(<RoutingPanel keys={["key"]} remarks={{}} />);expect(await screen.findByRole("option",{name:"small"})).toBeTruthy();
  expect(proxyApi.desktopClientModels).not.toHaveBeenCalled();expect(routingApi.configure).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"proxy.route.save"}));await waitFor(()=>expect(routingApi.configure).toHaveBeenCalledWith(expect.objectContaining({apiKey:"key",classifier:"small",enabled:true})));
});
it("tools clear a removed client key and prevent stale model discovery",async()=>{
  toolsApi.status.mockResolvedValue({mode:"local",roots:[],model:"vision",searchKeyEnv:"KEY",summarize:false});
  const rendered=render(<ProxyToolsPanel keys={["old"]} />);await screen.findByRole("option",{name:"vision"});
  rendered.rerender(<ProxyToolsPanel keys={[]} />);await waitFor(()=>expect(screen.getByRole("button",{name:"proxy.desktop.models"}).disabled).toBe(true));
  expect(toolsApi.configure).not.toHaveBeenCalled();expect(toolsApi.mount).not.toHaveBeenCalled();
});
it("editing project distribution invalidates a reviewed preview",async()=>{
  distributionApi.list.mockResolvedValue({roleApps:["claude"],projectApps:["claude"],skills:[],mcp:[],subagents:[],projects:[]});
  distributionApi.preview.mockResolvedValue({revision:"r1",changes:[],errors:[]});render(<LibraryDistributionPanel />);
  await waitFor(()=>expect(screen.getByRole("button",{name:"pswitch.distribution.preview"}).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("pswitch.distribution.name"),{target:{value:"review-code"}});
  fireEvent.click(screen.getByRole("button",{name:"pswitch.distribution.preview"}));await screen.findByRole("button",{name:"pswitch.distribution.apply"});
  fireEvent.change(screen.getByLabelText("pswitch.distribution.purpose"),{target:{value:"changed"}});
  expect(screen.queryByRole("button",{name:"pswitch.distribution.apply"})).toBeNull();expect(distributionApi.apply).not.toHaveBeenCalled();
});
