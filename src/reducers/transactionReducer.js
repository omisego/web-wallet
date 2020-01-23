import { keyBy } from 'lodash';
const initialState = {};

function transactionReducer (state = initialState, action) {
  switch (action.type) {
    case 'TRANSACTION/GETALL/SUCCESS':
      return { ...state, ...keyBy(action.payload, 'txhash') };
    default:
      return state;
  }
}

export default transactionReducer;