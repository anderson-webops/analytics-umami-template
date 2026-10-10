/* eslint-disable no-console */

import { downloadNameData } from './download-name-data.mjs';

for (const filename of await downloadNameData('country')) {
  console.log('Downloaded', filename);
}
