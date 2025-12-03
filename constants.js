
  export const BRANCHES = [
    {code:'BKT', name:'Blacktown'},
    {code:'BON', name:'Bondi'},
    {code:'BUR', name:'Burwood'}, 
    {code:'CHC', name:'Chatswood Chase'},
    {code:'HOB', name:'Hornsby'},
    {code:'EMP', name:'Melbourne Emporium'},
    {code:'PA1', name:'Parramatta'},
    {code:'PEN', name:'Penrith'},
    {code:'ETG', name:'Eastgardens'},
    {code:'HUR', name:'Hurstville'},
    {code:'BOH', name:'Box Hill'},
    {code:'DON', name:'Doncaster'},
    {code:'CHW', name:'Chatswood Westfield'},
    {code:'MQU', name:'Macquarie'},
    {code:'TOP', name:'Top Ryde'},
    {code:'IND', name:'Indooroopilly'},
  ]
  

export const STOCK_TYPES = [
  { id: 1, description: "Consultation Item", accountCode: "82240" },
  { id: 2, description: "Spectacle Frame", accountCode: "40002" },
  { id: 3, description: "Sunglasses", accountCode: "40003" },
  { id: 4, description: "Spectacle Lens", accountCode: "40004" },
  { id: 5, description: "Contact Lens", accountCode: "40005" },
  { id: 6, description: "Solution", accountCode: "40006" },
  { id: 7, description: "Other Item", accountCode: "40006" },
  { id: 8, description: "Spectacle Lens Addon", accountCode: "40004" },
  { id: 9, description: "Spectacle Lens Tint", accountCode: "40004" },
  { id: 10, description: "Contact Lens Tint", accountCode: "40005" }
];

// POS Clearing Account Code
export const CLEARING_ACCOUNT_CODE = "18011";

// Clearing 계정 코드 목록 (Xero Journals 동기화용)
export const CLEARING_ACCOUNT_CODES = [
  '18000', // Clearing - Cash
  '18001', // Clearing - Eftpos
  '18002', // Clearing - Amex
  '18003', // Clearing - Hicaps
  '18004', // Clearing - BNPL
  '18005', // Clearing - Direct Deposit
  '18006', // Clearing - PayPal
];

export const PAYMENT_TYPES = [
  { code: "EFT", description: "EFTPOS - Cheque/Savings", accountCode: "18001" },
  { code: "VIS", description: "EFTPOS - Visa", accountCode: "18001" },
  { code: "MAS", description: "EFTPOS - MasterCard", accountCode: "18001" },
  { code: "AMX", description: "EFTPOS - American Express", accountCode: "18001" },
  { code: "DIN", description: "EFTPOS - Diners", accountCode: "18001" },
  { code: "OTH", description: "EFTPOS - Other", accountCode: "18001" },
  { code: "CAS", description: "Cash", accountCode: "18000" },
  { code: "CHQ", description: "Cheque", accountCode: "18000" },
  { code: "VOU", description: "Voucher", accountCode: "63071" },
  { code: "DDP", description: "Direct Deposit", accountCode: "18005" },
  { code: "HFD", description: "Health Fund", accountCode: "18003" },
  { code: "AFT", description: "Pay Later - Afterpay", accountCode: "18004" },
  { code: "ZIP", description: "Pay Later - zipPay", accountCode: "18004" },
  { code: "OPN", description: "Pay Later - Openpay", accountCode: "18004" },
  { code: "OTP", description: "Pay Later - Other", accountCode: "18004" },
  { code: "LAT", description: "Pay Later - LatitudePay", accountCode: "18004" }
];
  