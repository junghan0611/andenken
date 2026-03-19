{
  description = "andenken — recollective thinking: semantic memory for humans and AI agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
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
            nodejs_22
            nodePackages.typescript
            nodePackages.npm
          ];
          shellHook = ''
            echo "andenken — recollective thinking"
            echo "================================="
            echo "Node: $(node --version)"
            echo ""
            echo "  npm install              # install dependencies"
            echo "  npm test                 # run tests"
            echo "  npx tsx cli.ts status    # check index status"
            echo ""
          '';
        };
      });
}
