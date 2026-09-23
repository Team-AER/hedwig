// Real-looking mail for the card detector tests (shapes as senders actually send them).
export const ORDER_JSONLD = `<html><head><script type="application/ld+json">
{
  "@context": "http://schema.org",
  "@type": "Order",
  "merchant": { "@type": "Organization", "name": "Nordic Outdoor AS" },
  "orderNumber": "NO-448120",
  "orderDate": "2026-09-20T14:02:00+02:00",
  "priceCurrency": "NOK",
  "price": "1299.00",
  "acceptedOffer": [{
    "@type": "Offer",
    "itemOffered": { "@type": "Product", "name": "Trail running shoes" },
    "price": "1299.00", "priceCurrency": "NOK",
    "eligibleQuantity": { "@type": "QuantitativeValue", "value": "1" }
  }],
  "orderDelivery": {
    "@type": "ParcelDelivery",
    "carrier": { "@type": "Organization", "name": "Posten" },
    "trackingNumber": "70712345678901234",
    "trackingUrl": "https://sporing.posten.no/sporing/70712345678901234",
    "expectedArrivalUntil": "2026-09-24T16:00:00+02:00",
    "deliveryStatus": { "@type": "OrderStatus", "name": "http://schema.org/OrderInTransit" }
  }
}
</script></head><body><p>Thanks for your order!</p></body></html>`;

export const FLIGHT_JSONLD = `<script type="application/ld+json">[{
  "@context": "http://schema.org", "@type": "FlightReservation", "reservationNumber": "XK7P2Q",
  "reservationStatus": "http://schema.org/Confirmed",
  "underName": { "@type": "Person", "name": "Prakhar Demo" },
  "reservationFor": { "@type": "Flight", "flightNumber": "DY 604",
    "airline": { "@type": "Airline", "name": "Norwegian", "iataCode": "DY" },
    "departureAirport": { "@type": "Airport", "name": "Bergen Flesland", "iataCode": "BGO" },
    "departureTime": "2026-10-02T07:10:00+02:00",
    "arrivalAirport": { "@type": "Airport", "name": "Oslo Gardermoen", "iataCode": "OSL" },
    "arrivalTime": "2026-10-02T08:05:00+02:00" }
}, {
  "@context": "http://schema.org", "@type": "LodgingReservation", "reservationNumber": "BK-99812",
  "reservationFor": { "@type": "LodgingBusiness", "name": "Hotel Bristol",
    "address": { "@type": "PostalAddress", "streetAddress": "Kristian IVs gate 7", "addressLocality": "Oslo" } },
  "checkinTime": "2026-10-02T15:00:00+02:00", "checkoutTime": "2026-10-04T11:00:00+02:00"
}]</script>`;

export const INVOICE_JSONLD = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Invoice",
"provider":{"@type":"Organization","name":"Fjordkraft"},"confirmationNumber":"INV-2026-0912",
"totalPaymentDue":{"@type":"PriceSpecification","price":1240,"priceCurrency":"NOK"},
"paymentDueDate":"2026-09-25","paymentStatus":"https://schema.org/PaymentDue"}</script>`;

export const EVENT_JSONLD = `<script type="application/ld+json">{"@context":"http://schema.org","@type":"EventReservation",
"reservationNumber":"TM-5512","reservationFor":{"@type":"Event","name":"Bergen Philharmonic: Mahler 2",
"startDate":"2026-10-09T19:30:00+02:00","location":{"@type":"Place","name":"Grieghallen"}}}</script>`;

export const ORDER_MICRODATA = `<div itemscope itemtype="http://schema.org/Order">
  <div itemprop="merchant" itemscope itemtype="http://schema.org/Organization"><meta itemprop="name" content="Bookshop Ltd"/></div>
  <span itemprop="orderNumber">BS-10023</span>
  <meta itemprop="priceCurrency" content="GBP"/>
  <span itemprop="price">24.98</span>
  <link itemprop="orderStatus" href="http://schema.org/OrderProcessing"/>
  <div itemprop="acceptedOffer" itemscope itemtype="http://schema.org/Offer">
    <div itemprop="itemOffered" itemscope itemtype="http://schema.org/Book"><span itemprop="name">The Overstory</span></div>
    <span itemprop="price">12.49</span>
  </div>
</div>`;

export const ICS_INVITE = [
  'BEGIN:VCALENDAR', 'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN', 'VERSION:2.0', 'METHOD:REQUEST',
  'BEGIN:VTIMEZONE', 'TZID:W. Europe Standard Time', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'ORGANIZER;CN="Anna Berg":mailto:anna.berg@school.example',
  'DTSTART;TZID=W. Europe Standard Time:20260924T183000', 'DTEND;TZID=W. Europe Standard Time:20260924T200000',
  'UID:040000008200E00074C5B7101A82E0080000000070DA', 'SEQUENCE:0',
  'SUMMARY;LANGUAGE=en-GB:Parents\' evening\\, class 4B', 'LOCATION:Møhlenpris skole\\, room 12',
  'BEGIN:VALARM', 'DESCRIPTION:REMINDER', 'TRIGGER;RELATED=START:-PT15M', 'ACTION:DISPLAY', 'END:VALARM',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

export const ICS_CANCEL = ICS_INVITE.replace('METHOD:REQUEST', 'METHOD:CANCEL').replace('SEQUENCE:0', 'SEQUENCE:1\r\nSTATUS:CANCELLED');

export const ICS_ALLDAY = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:holiday-1@example', 'DTSTART;VALUE=DATE:20261012',
  'DTEND;VALUE=DATE:20261015', 'SUMMARY:Autumn break', 'END:VEVENT', 'END:VCALENDAR'].join('\n');

export const DHL_MAIL = {
  subject: 'Your DHL shipment is out for delivery',
  from_name: 'DHL Express', from_email: 'noreply@dhl.example',
  body_text: 'Hello,\n\nYour shipment with waybill number 1234567890 is out for delivery today.\nExpected delivery: today by 16:00.\n\nTrack your shipment: https://www.dhl.com/track?AWB=1234567890\n\nCustomer service: call 0180 5 345300 11',
  body_html: '<p>Your shipment with waybill number 1234567890 is out for delivery today.</p><a href="https://www.dhl.com/track?AWB=1234567890">Track</a>',
};

export const UPS_MAIL = {
  subject: 'UPS Update: Package Scheduled for Delivery Thursday',
  from_name: 'UPS', from_email: 'mcinfo@ups.example',
  body_text: 'Your package is on the way.\nTracking Number: 1Z999AA10123456784\nScheduled Delivery: Thursday, 24 September\nShipped from: Bookshop Ltd',
};

export const ROYAL_MAIL = {
  subject: 'Your parcel has been delivered',
  from_name: 'Royal Mail', from_email: 'no-reply@royalmail.example',
  body_text: 'Good news! Your item AB123456785GB has been delivered to your safe place.',
};

export const OTP_MAIL = {
  subject: 'Your sign-in code',
  from_name: 'Vipps', from_email: 'no-reply@vipps.example',
  body_text: 'Use this verification code to sign in: 482 913\n\nThe code expires in 10 minutes. If you did not ask for it, ignore this email.',
};

export const GOOGLE_CODE = { subject: 'G-731904 is your Google verification code', from_name: 'Google', from_email: 'noreply@google.example', body_text: 'Enter this code to continue.' };

export const BOOKING_CONFIRMATION = {
  subject: 'Booking confirmed',
  from_name: 'Norwegian', from_email: 'booking@norwegian.example',
  body_text: 'Your booking is confirmed. Your confirmation code is XK7P2Q for flight DY604 on 2 October.',
};

// ── Shapes from the production mailbox (audit 2026-09-24): no schema.org markup anywhere. Names,
// numbers and wording are paraphrased; the structure is what these senders send. ──

export const SHOPIFY_ORDER = {
  subject: 'Order #24176 confirmed',
  from_name: 'REES52', from_email: 'store+61890429095@t.shopifyemail.com',
  body_text: 'Thank you for your purchase!\nREES52 Order #24176\n\nWe\'re getting your order ready to be shipped. We will notify you when it has been sent.\n\nView your order ( https://rees52.example/61890429095/orders/14e59f43b3691e3cfaac0d401a0d8bca/authenticate?key=abc )\n\nOrder summary\nESP32 dev board × 2\nSubtotal ₹1,180.00\nShipping ₹60.00\nTotal ₹1,240.00 INR',
};

export const SHOPIFY_SHIPPED = {
  subject: 'A shipment from order #24176 is on the way',
  from_name: 'REES52', from_email: 'store+61890429095@t.shopifyemail.com',
  body_text: 'Your order is on the way\nREES52 Order #24176\n\nYour order is on the way. Track your shipment to see the delivery status.\nView your order ( https://rees52.example/61890429095/orders/14e59f43 )\n\nBluedart tracking number: 90667948000\n( https://www.bluedart.example/trackdart?trackNo=90667948000 )',
};

export const INDIGO_TAX_INVOICE = {
  subject: 'TaxInvoice - KL1262707AI06924',
  from_name: '6EGSTInvoice@goindigo.in', from_email: '6egstinvoice@goindigo.in',
  body_text: 'Dear IndiGo Customer, Please find attached the Tax Invoice/GST Credit Note for your booking. For more details on fare, change/cancellation charges, refunds, please refer to your IndiGo Itinerary also. Regards, Team IndiGo',
};

export const MMT_ETICKET = {
  subject: 'E-Ticket for Your Flight Booking ID: NF2AMMAN26756695696',
  from_name: 'MakeMyTrip', from_email: 'noreply@makemytrip.com',
  body_text: 'Flight Confirmation Hi Prakhar, thank you for booking with us. Booking Confirmed Kochi - Bagdogra Round Trip, Fri, 31 Jul Booking ID:NF2AMMAN26756695696, (Booked on 27 Jul 2026) Booking Details Kochi-Bagdogra Fri, 31 Jul 2026 IndiGo 6E 539 PNR: HCYP2A Kochi COK 09:30 hrs Fri, Jul 31 Cochin International Airport Terminal 1',
};

export const BOOKMYSHOW_TICKETS = {
  subject: 'Your Tickets',
  from_name: 'BookMyShow', from_email: 'tickets@bookmyshow.email',
  body_text: 'Your booking is confirmed! Booking ID TGAMAVT Spider-Man (4DX 3D) 07:50pm | Wed, 5 Aug, 2026 PVR: Lulu, Kochi ORDER SUMMARY TICKET AMOUNT Rs.1260.00 2 tickets Convenience fees Rs.162.84 DISCOUNT Rs.100.00 AMOUNT PAID Rs.1322.84 Booking Date & Time Sun, 12 Jul, 2026',
};

export const SHOP_PAYMENT_RECEIVED = {
  subject: 'Order Payment Received',
  from_name: 'MD Computers', from_email: 'info@mdcomputers.in',
  body_text: 'Dear Customer, Order ID: 1530876 Thank you for placing the order with us. Please note that in order to process this order, there is a requirement for both side copies of your PAN card.',
};

export const NEWSLETTER_ORDER_WORDS = {
  subject: 'How a dead IT company walked into the defence boom and an order from Reliance',
  from_name: 'The Ken', from_email: 'info@the-ken.com',
  body_text: 'In 2019 the company had 40 employees. Then came an order from a large conglomerate worth Rs 450 crore, and the order book grew 2026 times over the decade.',
};

export const SUPPLIER_PO = {
  subject: 'RE: PO: 40496953 // PL: 282069315',
  from_name: 'Pradeesha V', from_email: 'pradeesha.v@mouser.example',
  body_text: 'Dear customer, please share the KYC documents for this purchase order so we can release the shipment.',
};
