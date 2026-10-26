EDITOR_CLI ?= $(shell command -v positron || echo /Applications/Positron.app/Contents/Resources/app/bin/code)

all: clean package

clean:
	npm run clean

package:
	npm run package

test:
	npm test

# run the extension in a development host
dev:
	npm run build
	"$(EDITOR_CLI)" --extensionDevelopmentPath=$(PWD)

install: all
	"$(EDITOR_CLI)" --install-extension positron-snakemake.vsix

# drive the extension in Positron against test-e2e/workflow (see test-e2e/run.sh)
e2e:
	npm run build
	test-e2e/run.sh
