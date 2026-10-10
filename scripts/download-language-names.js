/* eslint-disable no-console */

import { downloadNameData } from './download-name-data.mjs';

for (const filename of await downloadNameData('language')) {
  console.log('Downloaded', filename);
}
