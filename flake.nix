{
  description = "MCP server for SEGGER J-Link debug probes";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-parts,
      ...
    }@inputs:
    flake-parts.lib.mkFlake { inherit inputs; } (
      { ... }:
      {
        imports = [
          flake-parts.flakeModules.easyOverlay
        ];

        systems = nixpkgs.lib.systems.flakeExposed;

        perSystem =
          {
            config,
            pkgs,
            lib,
            ...
          }: let
                packageJson = lib.importJSON ./package.json;
              in
          {
            overlayAttrs = {
              inherit (config.packages) jlink-mcp jlink-mcp-skills;
            };

            packages.default = config.packages.jlink-mcp;

            packages.jlink-mcp =
              pkgs.buildNpmPackage {
                pname = "jlink-mcp";
                inherit (packageJson) version;

                src = ./.;

                npmDeps = pkgs.importNpmLock {
                  npmRoot = ./.;
                };

                npmConfigHook = pkgs.importNpmLock.npmConfigHook;

                nativeBuildInputs = [
                  pkgs.makeWrapper
                  pkgs.pkg-config
                ];

                buildInputs = lib.optionals pkgs.stdenv.hostPlatform.isLinux [
                  pkgs.libsecret
                ];

                npmBuildScript = "build";

                dontNpmInstall = true;

                installPhase = ''
                  runHook preInstall

                  mkdir -p $out/lib/jlink-mcp
                  cp -r out $out/lib/jlink-mcp/
                  cp package.json $out/lib/jlink-mcp/

                  mkdir -p $out/bin
                  makeWrapper ${lib.getExe pkgs.nodejs} $out/bin/jlink-mcp \
                    --add-flags "$out/lib/jlink-mcp/out/mcp/standalone.js"

                  runHook postInstall
                '';

                meta = {
                  description = "MCP server for SEGGER J-Link debug probes, enabling LLM-driven embedded debugging with RTT, GDB server, and Trice/Pigweed support";
                  homepage = "https://github.com/Klievan/jlink-mcp";
                  license = lib.licenses.mit;
                  mainProgram = "jlink-mcp";
                  platforms = lib.platforms.all;
                };
              };

            packages.jlink-mcp-skills =
              pkgs.stdenvNoCC.mkDerivation {
                pname = "jlink-mcp-skills";
                inherit (packageJson) version;

                src = ./skills;

                installPhase = ''
                  runHook preInstall
                  mkdir -p $out/share/skills
                  cp -r . $out/share/skills/
                  runHook postInstall
                '';

                meta = {
                  description = "Agent skills for jlink-mcp embedded debugging";
                  homepage = "https://github.com/Klievan/jlink-mcp";
                  license = lib.licenses.mit;
                  platforms = lib.platforms.all;
                };
              };

            devShells.default = pkgs.mkShell {
              packages = with pkgs; [
                nodejs_22
                typescript
                esbuild
              ];
            };
          };
      }
    );
}