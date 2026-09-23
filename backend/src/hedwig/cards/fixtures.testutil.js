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
