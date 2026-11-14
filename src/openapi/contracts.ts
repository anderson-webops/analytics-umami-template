import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverContractFiles } from '@/openapi/discover';
import type { ApiOperationContract, LoadedApiOperationContract } from '@/openapi/operation';

interface ContractModule {
  operations?: readonly ApiOperationContract[];
}

export interface ContractLoadOptions {
  includeGenerated?: boolean;
}

export async function loadApiContracts(
  projectRoot = process.cwd(),
  options: ContractLoadOptions = {},
): Promise<LoadedApiOperationContract[]> {
  const contractFiles = (await discoverContractFiles(projectRoot)).filter(
    file => options.includeGenerated !== false || path.basename(file) !== 'contract.generated.ts',
  );
  const contracts: LoadedApiOperationContract[] = [];

  for (const contractFile of contractFiles) {
    const module = (await import(pathToFileURL(contractFile).href)) as ContractModule;

    if (!Array.isArray(module.operations)) {
      throw new Error(
        `${path.relative(projectRoot, contractFile)} must export an \`operations\` array.`,
      );
    }

    const source = path.relative(projectRoot, contractFile).replaceAll(path.sep, '/');

    module.operations.forEach(operation => {
      contracts.push({ ...operation, source, origin: 'explicit' });
    });
  }

  return contracts;
}
