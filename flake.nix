{
  description = "andenken — recollective thinking: semantic memory for humans and AI agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          name = "andenken";
          buildInputs = with pkgs; [
            nodejs
            pnpm
          ];
          # The banner goes to stderr so `nix develop -c <cmd> --json` keeps stdout to <cmd>.
          shellHook = ''
            {
              echo "andenken — recollective thinking"
              echo "================================="
              echo "Node: $(node --version)"
              echo ""
              echo "  pnpm install             # install dependencies"
              echo "  ./run.sh test:unit       # run offline unit tests"
              echo "  ./run.sh status          # check index status"
              echo ""
            } >&2
          '';
        };
      });
}
