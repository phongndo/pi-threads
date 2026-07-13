{
  description = "pi-dispatch development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              git
              jq
              nil
              nixd
              nixfmt
              nodejs_22
              oxfmt
              oxlint
              pnpm
              typescript-language-server
              vscode-langservers-extracted
              yaml-language-server
            ];

            shellHook = ''
              export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
              # Provide hk + pkl via mise.toml if mise is available
              if command -v mise &>/dev/null; then
                mise trust --yes 2>/dev/null || true
              fi
              echo "pi-dispatch: pnpm, oxlint, oxfmt, and LSPs are available."
              echo "  hk hooks: managed via mise.toml + global Git hooks"
            '';
          };
        }
      );

      formatter = forAllSystems (system: (import nixpkgs { inherit system; }).nixfmt);
    };
}
