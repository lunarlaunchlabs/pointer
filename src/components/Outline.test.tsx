import { describe, expect, it } from "vitest";
import { scanByRegex } from "./Outline";

describe("scanByRegex", () => {
  it("detects common TypeScript and React declaration shapes", () => {
    const symbols = scanByRegex(
      [
        "export default function App() {",
        "  return null;",
        "}",
        "",
        "export const Card: React.FC<Props> = ({ title }) => <h1>{title}</h1>;",
        "",
        "class Store {",
        "  async loadUser(id: string): Promise<User> {",
        "    return fetchUser(id);",
        "  }",
        "}",
      ].join("\n"),
      "typescriptreact",
    );

    expect(symbols.map((s) => `${s.kindLabel}:${s.name}`)).toEqual([
      "Function:App",
      "Function:Card",
      "Class:Store",
      "Method:loadUser",
    ]);
  });

  it("detects symbols across server-side and systems languages", () => {
    const source = [
      "async def fetch_user():",
      "  pass",
      "public class UserService {",
      "  public static String renderGreeting(String name) { return name; }",
      "}",
      "pub enum Mode { Fast }",
      "impl<T> Store<T> {",
      "  pub async fn load(&self) {}",
      "}",
      "func (s *Server) ServeHTTP() {}",
      "public func renderGreeting() -> String { \"hello\" }",
      "def self.normalize!",
    ].join("\n");

    const symbols = scanByRegex(source, "plaintext");
    expect(symbols.map((s) => `${s.kindLabel}:${s.name}`)).toEqual([
      "Function:fetch_user",
      "Class:UserService",
      "Method:renderGreeting",
      "Enum:Mode",
      "Impl:Store<T>",
      "Function:load",
      "Function:ServeHTTP",
      "Function:renderGreeting",
      "Function:normalize!",
    ]);
  });

  it("uses markdown headings as outline entries", () => {
    const symbols = scanByRegex(
      ["# Intro", "Text", "## Details", "### Notes"].join("\n"),
      "markdown",
    );

    expect(symbols.map((s) => `${s.kindLabel}:${s.name}:${s.line}`)).toEqual([
      "H1:Intro:1",
      "H2:Details:3",
      "H3:Notes:4",
    ]);
  });
});
