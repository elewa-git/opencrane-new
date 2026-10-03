FROM debian:trixie-slim@sha256:7792b1f7702a86946cd518db72b6a407302c3e9bc1635634368b878189e8221c AS base
# Signed, fixed Debian main snapshot; never install from contrib/non-free or PyPI.
RUN rm /etc/apt/sources.list.d/debian.sources && \
    echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261002T000000Z/ trixie main' > /etc/apt/sources.list && \
    echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261002T000000Z/ trixie-security main' >> /etc/apt/sources.list

COPY apps/computer/collect-licences.py /tmp/collect-licences.py

FROM base AS database
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends postgresql-17=17.11-0+deb13u1 python3 && \
    mkdir -p /usr/share/opencrane && \
    python3 /tmp/collect-licences.py apt > /usr/share/opencrane/apt-packages.json && \
    rm -rf /var/lib/apt/lists/* /tmp/collect-licences.py /var/lib/postgresql/17/main && \
    usermod -u 1000 postgres && chown -R 1000:1000 /var/lib/postgresql
USER postgres
ENTRYPOINT ["python3", "/fixture/database.py"]

FROM base AS operator
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends socat python3 && \
    mkdir -p /usr/share/opencrane && \
    python3 /tmp/collect-licences.py apt > /usr/share/opencrane/apt-packages.json && \
    rm -rf /var/lib/apt/lists/* /tmp/collect-licences.py
USER 1000:1000
ENTRYPOINT ["socat"]

FROM base AS odoo
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    ca-certificates curl python3 python3-asn1crypto python3-babel python3-cbor2 \
    python3-chardet python3-cryptography python3-dateutil python3-decorator \
    python3-docutils python3-freezegun python3-geoip2 python3-gevent python3-greenlet \
    python3-idna python3-jinja2 python3-libsass python3-lxml \
    python3-lxml-html-clean python3-markupsafe python3-num2words python3-ofxparse \
    python3-openpyxl python3-passlib python3-pil python3-polib python3-psutil \
    python3-psycopg2 python3-openssl python3-pypdf python3-serial python3-magic \
    python3-ldap python3-stdnum python3-tz python3-usb python3-qrcode \
    python3-reportlab python3-requests python3-rjsmin python3-urllib3 \
    python3-vobject python3-werkzeug python3-xlrd python3-xlsxwriter python3-xlwt \
    python3-zeep && mkdir -p /usr/share/opencrane && \
    python3 /tmp/collect-licences.py apt > /usr/share/opencrane/apt-packages.json && \
    rm -rf /var/lib/apt/lists/* /tmp/collect-licences.py
RUN curl -fsSL https://codeload.github.com/odoo/odoo/tar.gz/643610127254ee77bbc756b6746739e9e9bb85ff -o /tmp/odoo.tar.gz && \
    echo '73e03d0198a9fc47b582dc3293326cd006a1a9c1f990f1d24ac5b5ba63f6455a /tmp/odoo.tar.gz' | sha256sum -c - && \
    mkdir /opt/odoo && tar -xzf /tmp/odoo.tar.gz --strip-components=1 -C /opt/odoo && \
    rm /tmp/odoo.tar.gz && useradd -u 1000 -m odoo
RUN mkdir -p /var/lib/odoo && chown odoo:odoo /var/lib/odoo
ENV PYTHONPATH=/opt/odoo PYTHONDONTWRITEBYTECODE=1
USER odoo
ENTRYPOINT ["python3", "/opt/odoo/odoo-bin"]

USER root
RUN rm -f /usr/lib/python3/dist-packages/lxml/isoschematron/resources/xsl/iso-schematron-xslt1/iso_schematron_message.xsl \
          /usr/lib/python3/dist-packages/lxml/isoschematron/resources/xsl/iso-schematron-xslt1/iso_schematron_skeleton_for_xslt1.xsl
USER odoo
