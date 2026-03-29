import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { CandyHonPlatform } from './platform';

export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, CandyHonPlatform);
};
